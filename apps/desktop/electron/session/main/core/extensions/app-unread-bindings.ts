import { z } from 'zod';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { boundEntryOf, boundPathOf, type AppBoundList, type AppBoundRead, type AppUnreadBinding, type StoredUnreadBinding } from '@shared/extensions/unread-binding';
import { DEFAULT_TEXT_MAX_BYTES, type AppComposeDetail, type AppFileEntry } from '@shared/extensions/app-runtime-protocol';
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
 * for this installed App, with that action declared and granted, of a conversation the account is still in. `recheck`
 * says it is all still so — account, installed App, grant and the same selection — and is called after every wait;
 * the last call of each verb has no wait after it. Null: nobody has chosen the conversation yet.
 */
async function boundConversation(extensionId: string, name: string, action: 'files' | 'draft') {
  const { token, ownerId } = await account();
  const before = extensionsService().conversationBinding(ownerId, extensionId, name, action);
  if (!before) return null;
  const recheck = async () => {
    await current(ownerId);
    if (extensionsService().conversationBinding(ownerId, extensionId, name, action)?.handle !== before.handle) throw denied('Conversation binding changed');
  };
  await member(token, ownerId, before.chatId);
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

/** `gugu.bindings.list(name, { folder? })` (40, `chat:files`): one folder of the bound conversation (`''` the top; none: all). */
export async function appBindingList(extensionId: string, input: unknown): Promise<AppBoundList> {
  const { name, folder } = argsOf(z.strictObject({ name: z.string(), folder: z.unknown().optional() }), input);
  const at = folder === undefined ? undefined : boundPathOf(folder, 'folder');
  const bound = await boundConversation(extensionId, name, 'files').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable' };
  if (!bound) return { name, state: 'unbound' };
  let entries: AppFileEntry[];
  try {
    await ownFolder(bound.chatId);
    await bound.recheck();
    entries = await boundConversationFiles.list(bound.chatId, at);
  } catch (error) {
    const code = codeOf(error);
    if (code !== 'not-found' && code !== 'failed') throw error;
    await bound.recheck();
    return { name, state: code === 'not-found' ? 'missing' : 'unavailable' };
  }
  await bound.recheck();
  return { name, state: 'ready', entries: entries.filter((entry) => entry.chat === bound.chatId).map(boundEntryOf) };
}

/** `gugu.bindings.read(name, path)` (40, `chat:files`): one file of the bound conversation by its path there, with its text. */
export async function appBindingRead(extensionId: string, input: unknown): Promise<AppBoundRead> {
  const { name, path } = argsOf(z.strictObject({ name: z.string(), path: z.unknown() }), input);
  const at = boundPathOf(path, 'path');
  const bound = await boundConversation(extensionId, name, 'files').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable' };
  if (!bound) return { name, state: 'unbound' };
  let read: Awaited<ReturnType<typeof boundConversationFiles.read>>;
  try {
    await ownFolder(bound.chatId);
    await bound.recheck();
    read = await boundConversationFiles.read(bound.chatId, at, DEFAULT_TEXT_MAX_BYTES);
  } catch (error) {
    if (codeOf(error) !== 'failed') throw error;
    await bound.recheck();
    return { name, state: 'unavailable' };
  }
  await bound.recheck();
  if (read.state !== 'ready') return { name, state: read.state };
  const { entry, content, truncated, totalSize, binary } = read;
  return { name, state: 'ready', entry: boundEntryOf(entry), content, truncated, totalSize, ...(binary ? { binary } : {}) };
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
  const { token, ownerId } = await account();
  if (ownerId !== expectedOwner) throw denied('Account changed');
  const service = extensionsService();
  const candidates: { extensionId: string; binding: StoredUnreadBinding }[] = [];
  for (const { manifest } of service.list().extensions) {
    const name = manifest.contributes.unreadSource?.binding;
    if (!name || !service.isEnabled(manifest.id) || !service.hasCapability(manifest.id, 'chat:unread')) continue;
    try {
      const binding = service.conversationUnreadBinding(ownerId, manifest.id, name);
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
      if (service.conversationUnreadBinding(ownerId, extensionId, binding.name)?.handle === binding.handle) result[extensionId] = binding;
    } catch (error) {
      // Confirmed withdrawal is absence of authority, not a failed/empty unread read.
      if ((error as { code?: string }).code !== 'denied') throw error;
    }
  }
  return result;
}
