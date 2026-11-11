import { z } from 'zod';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { boundEntryOf, boundPathOf, type AppBindingSurface, type AppBoundList, type AppBoundRead, type AppUnreadBinding, type StoredUnreadBinding } from '@shared/extensions/unread-binding';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { DEFAULT_TEXT_MAX_BYTES, type AppComposeDetail } from '@shared/extensions/app-runtime-protocol';
import { dispatchCallOf } from '@shared/extensions/app-dispatch-core';
import { currentAccountAccessToken } from './account-token';
import { extensionsService } from './extensions-root';
import { boundConversationFiles, unreadBindingChatChoices } from './app-files';

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
async function account() {
  const token = await currentAccountAccessToken();
  const ownerId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !ownerId) throw denied('Not signed in');
  return { token, ownerId };
}
async function current(ownerId: string) {
  if ((await account()).ownerId !== ownerId) throw denied('Account changed');
}
async function member(token: string, ownerId: string, chatId: string) {
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('active_members').select('chat_id').eq('user_id', ownerId).eq('chat_id', chatId).maybeSingle();
  if (error) throw Object.assign(new Error('Could not verify conversation membership'), { code: 'failed' });
  if (!data) throw denied('This account is not an active member of the conversation');
}

/** The installed page cannot nominate an owner, target chat or permission. */
export async function appUnreadBinding(extensionId: string, input: unknown): Promise<AppUnreadBinding> {
  const { name } = z.strictObject({ name: z.string() }).parse(input);
  const { token, ownerId } = await account();
  const before = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  if (!before) return { name, state: 'unbound', actions: extensionsService().conversationBindingActions(extensionId) };
  await member(token, ownerId, before.chatId);
  await current(ownerId);
  const after = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  if (after?.handle !== before.handle) throw denied('Conversation binding changed');
  return { name, state: 'bound', handle: after.handle, actions: extensionsService().conversationBindingActions(extensionId) };
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
function argsOf<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid(`gugu.bindings takes the binding's name and a path in its conversation, never a chat, account or file id (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  return parsed.data;
}

/**
 * #1927 The conversation one more action of the binding reaches (`files`, `draft`): the current account's own selection
 * for this installed App, with that action declared and granted, of a conversation the account is still in — for `files`,
 * one keeping its own folder (asked beside membership). `recheck` says it is all still so — account, installed App, grant
 * and the same selection — and is called after every wait; the last call of each verb has no wait after it. Null: nobody
 * has chosen the conversation yet.
 */
async function boundConversation(extensionId: string, name: string, action: 'files' | 'draft' | 'surface') {
  const { token, ownerId } = await account();
  const before = extensionsService().conversationBinding(ownerId, extensionId, name, action);
  if (!before) return null;
  const recheck = async () => {
    await current(ownerId);
    if (extensionsService().conversationBinding(ownerId, extensionId, name, action)?.handle !== before.handle) throw denied('Conversation binding changed');
  };
  const checks = await Promise.allSettled([member(token, ownerId, before.chatId), action === 'files' ? ownFolder(before.chatId) : undefined]);
  // A refusal outweighs a check that could not be made: the call is refused, not to be tried again.
  const failed = checks.find((check) => check.status === 'rejected' && codeOf(check.reason) === 'denied') ?? checks.find((check) => check.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  await recheck();
  return { chatId: before.chatId, recheck };
}

/**
 * A topic's files are its source chat's (`resourceChat`): reading them would reach a conversation the person did not
 * choose. Only a conversation that keeps its own folder is read.
 */
async function ownFolder(chatId: string): Promise<void> {
  const resource = await boundConversationFiles.resourceChat(chatId).catch((error: unknown) => {
    if (codeOf(error) === 'failed') throw error;
    throw denied('The chosen conversation cannot be read as this account');
  });
  if (resource !== chatId) throw denied('The chosen conversation keeps no folder of its own: its files are another conversation\'s');
}

/**
 * What `use` read of the bound conversation's folder, once the binding is still what it was; or why there is nothing:
 * unbound, missing (`not-found`), unavailable (`failed`, membership not verifiable). Any other failure is thrown as it is.
 */
async function inBoundFolder<T>(extensionId: string, name: string, use: (chatId: string) => Promise<T>): Promise<{ value: T } | { name: string; state: 'unbound' | 'missing' | 'unavailable' }> {
  const bound = await boundConversation(extensionId, name, 'files').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable' };
  if (!bound) return { name, state: 'unbound' };
  try {
    const value = await use(bound.chatId);
    await bound.recheck();
    return { value };
  } catch (error) {
    const code = codeOf(error);
    if (code !== 'not-found' && code !== 'failed') throw error;
    await bound.recheck();
    return { name, state: code === 'not-found' ? 'missing' : 'unavailable' };
  }
}

/** `gugu.bindings.list(name, { folder? })` (40, `chat:files`): one folder of the bound conversation (`''` the top; none: all). */
export async function appBindingList(extensionId: string, input: unknown): Promise<AppBoundList> {
  const { name, folder } = argsOf(z.strictObject({ name: z.string(), folder: z.unknown().optional() }), input);
  const at = folder === undefined ? undefined : boundPathOf(folder, 'folder');
  // A row of any other chat, whatever answered it, is not this conversation's file.
  const listed = await inBoundFolder(extensionId, name, async (chatId) =>
    (await boundConversationFiles.list(chatId, at)).filter((entry) => entry.chat === chatId).map(boundEntryOf));
  return 'value' in listed ? { name, state: 'ready', entries: listed.value } : listed;
}

/** `gugu.bindings.read(name, path)` (40, `chat:files`): one file of the bound conversation by its path there, with its text. */
export async function appBindingRead(extensionId: string, input: unknown): Promise<AppBoundRead> {
  const { name, path } = argsOf(z.strictObject({ name: z.string(), path: z.unknown() }), input);
  const at = boundPathOf(path, 'path');
  const read = await inBoundFolder(extensionId, name, (chatId) => boundConversationFiles.read(chatId, at, DEFAULT_TEXT_MAX_BYTES));
  if (!('value' in read)) return read;
  if (read.value.state !== 'ready') return { name, state: read.value.state };
  const { entry, ...text } = read.value;
  return { name, ...text, entry: boundEntryOf(entry) };
}

/**
 * `gugu.dispatch(text, { draft: true, to: { binding } })` (40, `chat:draft`): the text into the bound conversation's
 * composer, the one way any draft goes there (`draftInChat`). Nothing is sent: the person sends it, or not. The answer names
 * the binding, never the chat.
 */
export async function draftIntoBoundConversation(
  extensionId: string,
  args: Record<string, unknown>,
  draftInChat: (detail: AppComposeDetail) => Promise<void>,
): Promise<{ to: { binding: string } }> {
  const call = dispatchCallOf(args);
  if (!call.draft || !call.to || !('binding' in call.to)) throw invalid('A binding\'s conversation takes only a draft: { draft: true, to: { binding } }');
  const name = call.to.binding;
  const bound = await boundConversation(extensionId, name, 'draft');
  if (!bound) throw Object.assign(new Error(`No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`), { code: 'not-found' });
  await draftInChat({ chatId: bound.chatId, text: `${call.text}\n` });
  return { to: { binding: name } };
}

/**
 * #1925 What the host window says it draws now: an App's main page as the panel beside this conversation, the panel
 * collapsed or not (`reportConversationSurface`, from the trusted renderer, never from an App). Believed only for the
 * conversation the App's binding still reaches, checked again on every answer.
 */
type ShownSurface = { tabName: string; tabId: string; chatId: string; collapsed: boolean };
const shownSurfaces = new Map<string, ShownSurface>();
const surfaceReportSchema = z.strictObject({
  extensionId: z.string().min(1),
  tabKind: z.string().min(1),
  tabId: z.string().min(1),
  shown: z.strictObject({ chatId: z.string().uuid(), collapsed: z.boolean() }).nullable(),
});

/** Trusted renderer only, not an App bridge verb. True when what the App's pages hear changed. */
export function reportConversationSurface(input: unknown): boolean {
  const { extensionId, tabKind, tabId, shown } = surfaceReportSchema.parse(input);
  const tabName = tabKind.startsWith(`${extensionId}.`) ? tabKind.slice(extensionId.length + 1) : '';
  if (!tabName) throw invalid(`Tab kind "${tabKind}" does not belong to "${extensionId}"`);
  const before = shownSurfaces.get(extensionId);
  if (!shown) {
    if (before?.tabName !== tabName || before.tabId !== tabId) return false;
    shownSurfaces.delete(extensionId);
    return true;
  }
  const next = { tabName, tabId, ...shown };
  if (before && JSON.stringify(before) === JSON.stringify(next)) return false;
  shownSurfaces.set(extensionId, next);
  return true;
}

/** The binding an App's main page is placed beside (`contributes.conversationSurface`); none: it is not. */
export function conversationSurfaceBinding(manifest: ExtensionManifest): string | null {
  return manifest.contributes.conversationSurface?.binding ?? null;
}

/**
 * `gugu.bindings.surface(name)` (41, `chat:surface`), for the page asking: `bound` only while the window draws the very
 * conversation the binding reaches beside this page — the current account's own selection for this installed App, its
 * grant, still a member, the same selection after the wait. Anything else is `unbound`, whatever the reason: the App
 * hears neither which check failed nor the chat.
 */
export async function appBindingSurface(extensionId: string, page: { tabName: string; tabId: string }, input: unknown): Promise<AppBindingSurface> {
  const { name } = argsOf(z.strictObject({ name: z.string() }), input);
  if (conversationSurfaceBinding(extensionsService().get(extensionId).manifest) !== name) {
    throw denied(`"${name}" is not the binding this App's page is placed beside (contributes.conversationSurface)`);
  }
  const unbound = { name, state: 'unbound' } as const;
  const shownHere = () => {
    const shown = shownSurfaces.get(extensionId);
    return shown?.tabName === page.tabName && shown.tabId === page.tabId ? shown : null;
  };
  if (!shownHere()) return unbound;
  const bound = await boundConversation(extensionId, name, 'surface').catch(() => null);
  const shown = shownHere();
  if (!bound || !shown || shown.chatId !== bound.chatId) return unbound;
  return { name, state: 'bound', panel: { collapsed: shown.collapsed } };
}

/**
 * `gugu.bindings.setPanel(name, { collapsed })` (41): the page collapses or expands its own panel, only while it is drawn
 * beside its bound conversation (`ask` hands it to that page's window). Unbound, nothing changes.
 */
export async function setBindingSurfacePanel(
  extensionId: string,
  page: { tabName: string; tabId: string },
  input: unknown,
  ask: (collapsed: boolean) => Promise<void>,
): Promise<AppBindingSurface> {
  const { name, collapsed } = argsOf(z.strictObject({ name: z.string(), collapsed: z.boolean() }), input);
  const surface = await appBindingSurface(extensionId, page, { name });
  if (surface.state !== 'bound') return surface;
  if (surface.panel.collapsed !== collapsed) await ask(collapsed);
  return { name, state: 'bound', panel: { collapsed } };
}

/** Trusted App permissions UI only. This is not an App bridge verb. */
export async function unreadBindingChoices(extensionId: string, name: string) {
  const { ownerId } = await account();
  const authority = extensionsService().conversationUnreadAuthority(ownerId, extensionId, name);
  const selected = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  const chats = await unreadBindingChatChoices();
  await current(ownerId);
  if (extensionsService().conversationUnreadAuthority(ownerId, extensionId, name) !== authority) throw denied('App unread authority changed');
  return { ownerId, authority, selected: selected?.chatId ?? null, chats: chats.map(({ id, name: title, kind }) => ({ id, name: title, kind })) };
}

/** Host-only write; expectedOwner binds the person's selection to the account that drew it. */
export async function setUnreadBinding(input: unknown): Promise<void> {
  const args = z.strictObject({ extensionId: z.string(), name: z.string(), ownerId: z.string().uuid(), authority: z.string().uuid(), chatId: z.string().uuid().nullable() }).parse(input);
  const { token, ownerId } = await account();
  if (ownerId !== args.ownerId) throw denied('Account changed');
  const assertAuthority = () => {
    if (extensionsService().conversationUnreadAuthority(ownerId, args.extensionId, args.name) !== args.authority) throw denied('App unread authority changed');
  };
  assertAuthority();
  if (args.chatId !== null) await member(token, ownerId, args.chatId);
  await current(ownerId);
  assertAuthority();
  extensionsService().setConversationUnreadBinding(ownerId, args.extensionId, args.name, args.chatId);
}

/** Host projection reads a validated, current account association, never a page-supplied chat. */
export async function grantedUnreadBindings(expectedOwner: string): Promise<Record<string, StoredUnreadBinding>> {
  return grantedBindings(expectedOwner, 'chat:unread', (manifest) => manifest.contributes.unreadSource?.binding,
    (service, ownerId, extensionId, name) => service.conversationUnreadBinding(ownerId, extensionId, name));
}

/**
 * #1925 The same projection for the trusted window that draws an App's main page beside its bound conversation: the Apps
 * placing their page there (`contributes.conversationSurface`), with the `surface` action granted, of a conversation the
 * current account is still in.
 */
export async function grantedSurfaceBindings(expectedOwner: string): Promise<Record<string, StoredUnreadBinding>> {
  return grantedBindings(expectedOwner, 'chat:surface', conversationSurfaceBinding,
    (service, ownerId, extensionId, name) => service.conversationBinding(ownerId, extensionId, name, 'surface'));
}

type Service = ReturnType<typeof extensionsService>;
async function grantedBindings(
  expectedOwner: string,
  capability: 'chat:unread' | 'chat:surface',
  nameOf: (manifest: ExtensionManifest) => string | null | undefined,
  selection: (service: Service, ownerId: string, extensionId: string, name: string) => StoredUnreadBinding | null,
): Promise<Record<string, StoredUnreadBinding>> {
  const { token, ownerId } = await account();
  if (ownerId !== expectedOwner) throw denied('Account changed');
  const service = extensionsService();
  const candidates: { extensionId: string; binding: StoredUnreadBinding }[] = [];
  for (const { manifest } of service.list().extensions) {
    const name = nameOf(manifest);
    if (!name || !service.isEnabled(manifest.id) || !service.hasCapability(manifest.id, capability)) continue;
    try {
      const binding = selection(service, ownerId, manifest.id, name);
      if (binding) candidates.push({ extensionId: manifest.id, binding });
    } catch (error) {
      // Same rule as the re-check below: a denied grant (e.g. no verified publisher) is absence for this App only.
      if ((error as { code?: string }).code !== 'denied') throw error;
    }
  }
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const memberships = await fetchInChunks([...new Set(candidates.map(({ binding }) => binding.chatId))], async ids => {
    const { data, error } = await client.from('active_members').select('chat_id').eq('user_id', ownerId).in('chat_id', ids);
    if (error) throw Object.assign(new Error('Could not verify unread source membership'), { code: 'failed' });
    return (data ?? []) as { chat_id: string }[];
  });
  await current(ownerId);
  const active = new Set(memberships.map(row => row.chat_id));
  const result: Record<string, StoredUnreadBinding> = {};
  for (const { extensionId, binding } of candidates) {
    if (!active.has(binding.chatId)) continue;
    try {
      if (selection(service, ownerId, extensionId, binding.name)?.handle === binding.handle) result[extensionId] = binding;
    } catch (error) {
      // Confirmed withdrawal is absence of authority, not a failed/empty unread read.
      if ((error as { code?: string }).code !== 'denied') throw error;
    }
  }
  return result;
}
