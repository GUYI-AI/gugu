import { z } from 'zod';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { ASSISTANT_PROVISION_SELECT, pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';
import {
  ASSISTANT_NAME_MAX,
  ASSISTANT_SCREENS,
  ASSISTANT_SETUP_ADVANCES,
  assistantFigureSchema,
  pushedAssistantCountsSchema,
  pushedAssistantStatusSchema,
  renameCheck,
  setupAdvanceAllowed,
  withoutAssistant,
  type AppAssistantRead,
  type AssistantBindingAction,
  type AssistantRenameResult,
  type PushedAssistantCounts,
  type PushedAssistantStatus,
} from '@shared/extensions/assistant-binding';
import { appHostLayerReportSchema } from '@shared/extensions/app-host-layer';
import { forgetHostLayersForTest, hostLayerOf, reportHostLayer } from './app-host-layers';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';
import { unsupportedHere, type AppBindingUnsupported } from '@shared/extensions/phone-binding';
import { currentAccountAccessToken } from './account-token';
import { assistantServingChat } from './app-assistant-serving';
import { extensionsService } from './extensions-root';

/**
 * #1925 (API 44) An App's word about the person's own assistant, through its conversation binding (#1927). The authority
 * is #1927's — the signed-in account's own selection for this installed App (publisher included), that action declared and
 * its capability granted — and one more: the chosen conversation is the account's private chat with its own assistant
 * (the provision marker `assistant-app.ts` reads, and the chat's members). All of it is asked again after every wait. The
 * App names the binding and a value from a closed list; it never names, nor hears, a chat, device or account.
 */
const coded = (code: 'denied' | 'invalid' | 'failed' | 'not-found', message: string) => Object.assign(new Error(message), { code });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

async function account() {
  const token = await currentAccountAccessToken();
  const ownerId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !ownerId) throw coded('denied', 'Not signed in');
  return { token, ownerId };
}
async function current(ownerId: string) {
  if ((await account()).ownerId !== ownerId) throw coded('denied', 'Account changed');
}
function argsOf<T extends z.ZodType>(schema: T, input: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw coded('invalid', `${what} (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  return parsed.data;
}

/** The account's own assistant, by its provision marker; null: it has none. A marker that cannot be read is not "none". */
async function personalAssistant(token: string, ownerId: string): Promise<string | null> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('agent_provisions').select(ASSISTANT_PROVISION_SELECT).eq('owner_user_id', ownerId).eq('member_key', 'assistant');
  if (error) throw coded('failed', 'Could not verify the personal assistant');
  try {
    return pickAssistant((data ?? []) as AssistantProvisionRow[])?.agentId ?? null;
  } catch {
    throw coded('failed', 'Could not verify the personal assistant');
  }
}

/**
 * The signed-in account and its own assistant (by its provision marker), wherever that assistant lives — this computer,
 * another one, the cloud or a server. `denied`: no one is signed in; `failed`: the marker could not be read (never "none").
 */
export async function signedInAccountAssistant(): Promise<{ ownerId: string; assistantId: string | null }> {
  const { token, ownerId } = await account();
  return { ownerId, assistantId: await personalAssistant(token, ownerId) };
}

/** What the chosen conversation is, and who is in it now. */
async function conversationOf(token: string, chatId: string): Promise<{ kind: string | null; members: string[] }> {
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const [chat, members] = await Promise.all([
    client.from('chats').select('kind').eq('id', chatId).maybeSingle(),
    client.from('active_members').select('user_id').eq('chat_id', chatId),
  ]);
  if (chat.error || members.error) throw coded('failed', 'Could not verify the chosen conversation');
  return {
    kind: (chat.data as { kind?: string } | null)?.kind ?? null,
    members: ((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id),
  };
}

/**
 * Whether this conversation is the account's private chat with its own assistant and no one else — the one check every
 * assistant action makes (`boundAssistant`), also asked by the host's own binding of the trusted assistant App
 * (assistant-app-entry.ts). `failed`: it could not be verified now (never read as "no").
 *
 * `'pending'`: it is, but the assistant's setup has not reached the phase the store serves its resources in, so every call the
 * App would make over the binding is not valid yet (`assistantServingChat`, app-assistant-serving.ts). The host binds on
 * `true` only: a binding written sooner is one the App is refused over for good (verify-pass1 D4).
 */
export async function isOwnAssistantChat(token: string, ownerId: string, chatId: string): Promise<boolean | 'pending'> {
  const [assistant, conversation] = await Promise.all([personalAssistant(token, ownerId), conversationOf(token, chatId)]);
  if (!assistant) return false;
  const members = new Set(conversation.members);
  if (!(conversation.kind === 'dm' && members.size === 2 && members.has(ownerId) && members.has(assistant))) return false;
  const serving = await assistantServingChat(token, ownerId, chatId);
  return serving.state === 'served' ? true : serving.state === 'pending' ? 'pending' : false;
}

/**
 * The account the binding of this action stands for, once it is so: the binding chosen by this account for this installed
 * App, with the action declared and granted (`conversationBinding` refuses otherwise), and its conversation the account's
 * private chat with its own assistant and no one else. `recheck` asks the account and the binding again. Null: no
 * conversation chosen yet. `failed`: it could not be verified now.
 */
async function boundAssistant(extensionId: string, name: string, action: AssistantBindingAction) {
  const { token, ownerId } = await account();
  const before = extensionsService().conversationBinding(ownerId, extensionId, name, action);
  if (!before) return null;
  const recheck = async () => {
    await current(ownerId);
    if (extensionsService().conversationBinding(ownerId, extensionId, name, action)?.handle !== before.handle) throw coded('denied', 'Conversation binding changed');
  };
  const [assistant, conversation] = await Promise.all([personalAssistant(token, ownerId), conversationOf(token, before.chatId)]);
  if (!assistant) throw coded('denied', 'This account has no assistant of its own');
  const members = new Set(conversation.members);
  if (conversation.kind !== 'dm' || members.size !== 2 || !members.has(ownerId) || !members.has(assistant)) {
    throw coded('denied', 'The chosen conversation is not your private chat with your own assistant');
  }
  await recheck();
  return { ownerId, recheck };
}

/**
 * The assistant as this window last showed it (`useAssistantAppStatus` pushes it, `assistantStatusChanged`): whose it is
 * stays here. A window that has not shown it yet, or shows another account's, has nothing to tell.
 */
let shown: PushedAssistantStatus | null = null;
const statusFor = (ownerId: string) => (shown?.ownerId === ownerId ? shown.status : null);
/** The panel's numbers and the connect step's list as the session page last read them (assistant-app-counts.tsx), whose they are kept here too. */
let counted: PushedAssistantCounts | null = null;
const countsFor = (ownerId: string) => (counted?.ownerId === ownerId ? counted.counts : null);
const connectorsFor = (ownerId: string) => (counted?.ownerId === ownerId ? counted.connectors : null);
/** The host layer over each App's panel (`app-host-layer.ts`), as the window reported it, for which account: one record for
 * every host page (app-host-layers.ts) — the work binding's task conversations (46) as these panel pages. */
const hostPageFor = (extensionId: string, ownerId: string) => hostLayerOf(extensionId, ownerId) !== null;

/**
 * While this window shows the account no assistant (`none`, `loading`, `unreadable`), an App granted the action may start
 * the first setup whatever conversation is chosen, or none: it sees the snapshot without one (`withoutAssistant`), and may
 * open setup. Installed, enabled, declared and granted, as for its binding (`conversationBinding` refuses otherwise); the
 * snapshot is read after the last wait. Null: the window shows an assistant, or nothing yet — the binding decides.
 */
async function noAssistantShown(extensionId: string, name: string, action: AssistantBindingAction) {
  const { ownerId } = await account();
  extensionsService().conversationBinding(ownerId, extensionId, name, action);
  const status = statusFor(ownerId);
  return status && status.assistant !== 'found' ? { ownerId, status: withoutAssistant(status) } : null;
}

/** The answer of `status`. */
async function readStatus(extensionId: string, name: string): Promise<AppAssistantRead> {
  const none = await noAssistantShown(extensionId, name, 'assistant-status');
  if (none) return { name, state: 'ready', status: none.status, hostPage: hostPageFor(extensionId, none.ownerId) };
  const bound = await boundAssistant(extensionId, name, 'assistant-status').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable' };
  if (!bound) return { name, state: 'unbound' };
  const status = statusFor(bound.ownerId);
  if (!status) return { name, state: 'unavailable' };
  return {
    name, state: 'ready',
    status: status.assistant === 'found'
      ? { ...status, counts: countsFor(bound.ownerId), connectors: connectorsFor(bound.ownerId), nameMax: ASSISTANT_NAME_MAX }
      : withoutAssistant(status),
    hostPage: hostPageFor(extensionId, bound.ownerId),
  };
}

/** `gugu.assistant.status(name)` (44, `assistant:status`): the snapshot, or why there is none. */
export async function appAssistantStatus(extensionId: string, input: unknown): Promise<AppAssistantRead> {
  const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.assistant.status takes the binding\'s name alone');
  return readStatus(extensionId, name);
}

/**
 * `gugu.assistant.open(name, screen)` (44, `assistant:open`, in a click): the window opens that screen by its existing
 * entry (`act`). Answered done or refused; nothing of what the person does there. `setup` also while the account shows no
 * assistant (`noAssistantShown`); every other screen is the bound assistant's. `health` (49) is a phone's: here `unsupported`.
 */
export async function appAssistantOpen(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void | AppBindingUnsupported> {
  const { name, screen } = argsOf(z.strictObject({ name: z.string(), screen: z.enum(ASSISTANT_SCREENS) }), input,
    `gugu.assistant.open takes the binding's name and one of ${ASSISTANT_SCREENS.join(', ')}`);
  const none = screen === 'setup' ? await noAssistantShown(extensionId, name, 'assistant-open') : null;
  if (none) {
    await act({ kind: 'openAssistantScreen', screen, ownerId: none.ownerId });
    return;
  }
  const bound = await boundAssistant(extensionId, name, 'assistant-open');
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  // API 49 `health`: the phone's own health page (Health Connect, read on the phone); a computer has none — closed, never an error.
  if (screen === 'health') return unsupportedHere(name);
  await act({ kind: 'openAssistantScreen', screen, ownerId: bound.ownerId });
}

/**
 * `gugu.assistant.advanceSetup(name, next)` (44, `assistant:open`, in a click): the setup steps the App draws itself, moved
 * on through the built-in view's own `advanceSetup` (`act`) — connect → ready → done, checked here against the step this
 * window showed and there against the step it keeps.
 */
export async function appAssistantAdvanceSetup(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void> {
  const { name, next } = argsOf(z.strictObject({ name: z.string(), next: z.enum(ASSISTANT_SETUP_ADVANCES) }), input,
    'gugu.assistant.advanceSetup takes the binding\'s name and "ready" or "done"');
  const bound = await boundAssistant(extensionId, name, 'assistant-open');
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  const status = statusFor(bound.ownerId);
  if (!status) throw coded('failed', 'This window has not shown the assistant yet: try again in a moment');
  if (!setupAdvanceAllowed(status.setup, next)) {
    throw coded('invalid', `Setup is ${status.setup ?? 'not under way'}: it moves from connect to ready or done, and from ready to done`);
  }
  await act({ kind: 'advanceAssistantSetup', next, ownerId: bound.ownerId });
}

/**
 * `gugu.assistant.connect(name, id)` (44, `assistant:open`, in a click): the connect step's own click — the window opens
 * that service's connect dialog for the assistant's home (`act`, the built-in `useOpenConnector`). Only a service of the
 * list `status` shows (`connectors`, read); what the person does in the dialog is theirs.
 */
export async function appAssistantConnect(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void> {
  const { name, id } = argsOf(z.strictObject({ name: z.string(), id: z.string().max(100) }), input,
    'gugu.assistant.connect takes the binding\'s name and a connector id from status.connectors');
  const bound = await boundAssistant(extensionId, name, 'assistant-open');
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  const connectors = statusFor(bound.ownerId)?.assistant === 'found' ? connectorsFor(bound.ownerId) : null;
  if (connectors?.state !== 'ready') throw coded('failed', 'The connect list has not been read yet: try again in a moment');
  if (!connectors.value.some((connector) => connector.id === id)) throw coded('not-found', `No connector "${id}" in the list status shows`);
  await act({ kind: 'openAssistantConnector', id, ownerId: bound.ownerId });
}

/**
 * `gugu.assistant.rename(name, text)` (44, `assistant:rename`, in a click): the bound assistant renamed through the shell's
 * own `renameAssistant` (`act`), by the built-in field's rule (`renameCheck`, checked again there). A closed answer; a
 * refusal of the binding is thrown, as for every call.
 */
export async function appAssistantRename(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<AssistantRenameResult> {
  const { name, text } = argsOf(z.strictObject({ name: z.string(), text: z.string().max(1000) }), input,
    'gugu.assistant.rename takes the binding\'s name and the new name');
  const bound = await boundAssistant(extensionId, name, 'assistant-rename');
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  const status = statusFor(bound.ownerId);
  if (status?.assistant !== 'found') throw coded('failed', 'This window has not shown the assistant yet: try again in a moment');
  const check = renameCheck(text, status.name);
  if ('result' in check) return check.result;
  try {
    await act({ kind: 'renameAssistant', text: check.name, ownerId: bound.ownerId });
  } catch {
    return 'failed';
  }
  return 'renamed';
}

/**
 * `gugu.assistant.figure(name, figure)` (44, `assistant:status`): the host draws the assistant's moving figure over the
 * page (`act`) — what `status` shows of it, moving: the bound assistant's, or, while the account shows none, the setup
 * guide's bird (`draft`), as `status` answers then. null takes it away, whatever the binding is now.
 */
export async function appAssistantFigure(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void> {
  const { name, figure } = argsOf(z.strictObject({ name: z.string(), figure: assistantFigureSchema.nullable() }), input,
    'gugu.assistant.figure takes the binding\'s name and { x, y, size } (CSS pixels of the page), or null');
  // The last call wins. A place is checked (reads) before it is drawn, null is not: a page that asks for a place and then
  // takes it away (its face unmounted: another tab, the intro giving way to the panel) must not have the place drawn after
  // the null, with the figure left floating over whatever is there now (owner 11-12「怎么这里多了个鸟?」).
  const call = (figureCalls.get(extensionId) ?? 0) + 1;
  figureCalls.set(extensionId, call);
  const latest = () => figureCalls.get(extensionId) === call;
  if (!figure) {
    await act({ kind: 'assistantFigure', figure: null, ownerId: null, who: 'assistant' });
    return;
  }
  const none = await noAssistantShown(extensionId, name, 'assistant-status');
  if (!latest()) return;
  if (none) {
    await act({ kind: 'assistantFigure', figure, ownerId: none.ownerId, who: 'draft' });
    return;
  }
  const bound = await boundAssistant(extensionId, name, 'assistant-status');
  if (!latest()) return;
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  // As `status` would answer now: the window may not have shown it yet, or no longer shows one.
  const status = statusFor(bound.ownerId);
  if (!status) throw coded('failed', 'This window has not shown the assistant yet: try again in a moment');
  await act({ kind: 'assistantFigure', figure, ownerId: bound.ownerId, who: status.assistant === 'found' ? 'assistant' : 'draft' });
}

/** Each App's figure calls, counted: a place still being checked when a later call came is dropped. */
const figureCalls = new Map<string, number>();

/** The Apps whose last word was this account's snapshot without an assistant: each hears `unbound` once when one appears. */
const heardWithout = new Set<string>();

/**
 * Each App granted `assistant:status` (or that one alone) hears what `status` would answer it now (`hear`: its pages the
 * person works) — read after the waits, so the newest snapshot, never an older one over it.
 */
async function tell(hear: (extensionId: string, event: ExtensionHostEvent) => void, only?: string): Promise<void> {
  const service = extensionsService();
  await Promise.all(service.list().extensions.map(async ({ manifest }) => {
    const name = manifest.permissions?.bindings?.[0]?.name;
    if (only !== undefined && manifest.id !== only) return;
    if (!name || !manifest.permissions?.bindings?.[0]?.actions.includes('assistant-status')) return;
    if (!service.isEnabled(manifest.id) || !service.hasCapability(manifest.id, 'assistant:status')) {
      heardWithout.delete(manifest.id);
      return;
    }
    const read = await readStatus(manifest.id, name).catch(() => null);
    if (read?.state === 'ready') {
      if (read.status.assistant === 'found') heardWithout.delete(manifest.id);
      else heardWithout.add(manifest.id);
      hear(manifest.id, { type: 'assistantChanged', name, state: 'ready', status: read.status, hostPage: read.hostPage });
    } else if (read?.state === 'unbound' && heardWithout.delete(manifest.id)) {
      hear(manifest.id, { type: 'assistantChanged', name, state: 'unbound' });
    }
  }));
}

/**
 * The window's assistant changed (controller `assistantStatusChanged`): kept, and each App granted `assistant:status`
 * hears what `status` would answer it now (`hear`: that App's pages the person works) — the snapshot without an assistant
 * while there is none, the bound one's after. An App that heard the snapshot without one and now gets `unbound` (the
 * assistant appeared, its conversation not chosen) hears that once, never the later changes of an assistant it is not
 * pointed at. An App refused, withdrawn, disabled or removed hears nothing — checked for each change, as a read is.
 */
export async function assistantStatusChanged(input: unknown, hear: (extensionId: string, event: ExtensionHostEvent) => void): Promise<void> {
  const parsed = pushedAssistantStatusSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', 'Not an assistant snapshot an App may see');
  const same = shown?.ownerId === parsed.data.ownerId && JSON.stringify(shown.status) === JSON.stringify(parsed.data.status);
  if (shown?.ownerId !== parsed.data.ownerId) heardWithout.clear();
  shown = parsed.data;
  if (same) return;
  await tell(hear);
}

/**
 * The panel's numbers changed (controller `assistantCountsChanged`): kept for that account, and told as a new snapshot to
 * each App that would read them now (the bound assistant's: `counts` is null in any other answer).
 */
export async function assistantCountsChanged(input: unknown, hear: (extensionId: string, event: ExtensionHostEvent) => void): Promise<void> {
  const parsed = pushedAssistantCountsSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', 'Not assistant counts an App may see');
  const same = counted?.ownerId === parsed.data.ownerId && JSON.stringify([counted.counts, counted.connectors]) === JSON.stringify([parsed.data.counts, parsed.data.connectors]);
  counted = parsed.data;
  if (!same) await tell(hear);
}

/**
 * The window opened or closed the host layer over an App's panel (controller `reportHostLayer`): kept, and that App
 * told (`hostPage`) if it may read the assistant now. Only an installed App's; the layer is for the account it names.
 */
export async function appHostLayerChanged(input: unknown, hear: (extensionId: string, event: ExtensionHostEvent) => void): Promise<boolean> {
  const parsed = appHostLayerReportSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', 'Not a host layer report');
  const { extensionId } = parsed.data;
  if (!extensionsService().isInstalled(extensionId)) throw coded('denied', 'This App is not installed');
  // True: what the App's pages hear may have changed — its assistant status here; its surface and work (controller).
  const changed = reportHostLayer(parsed.data);
  if (changed) await tell(hear, extensionId);
  return changed;
}

/** Tests only: a window that has shown nothing. */
export function forgetShownAssistantForTest(): void {
  shown = null;
  counted = null;
  forgetHostLayersForTest();
  heardWithout.clear();
}
