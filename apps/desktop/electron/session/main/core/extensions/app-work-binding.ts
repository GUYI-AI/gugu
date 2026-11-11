import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';
import {
  WORK_HANDLE,
  pushedWorkLedgerSchema,
  type AppBindingWork,
  type AppWorkItem,
  type PushedWorkLedger,
} from '@shared/extensions/work-binding';
import { currentAccountAccessToken } from './account-token';
import { hostLayerOf } from './app-host-layers';
import { ownAssistantOfChat } from './app-own-assistant-chat';
import { extensionsService } from './extensions-root';

/**
 * #1925 (API 46) The work the person's own assistant handed out, for an App, through its conversation binding (#1927). The
 * authority is #1927's — the signed-in account's own selection for this installed App (publisher included), the `work` action
 * declared and `chat:work` granted — and one more: the chosen conversation is the account's private chat with its own
 * assistant (its provision marker, and the chat's members). All of it is asked again after every wait.
 *
 * The rows are the window's (AppWorkLedgerHost): it reads the account's ledger as the built-in list does — the same store,
 * the same agent presence — wherever the assistant lives, and hands main each new reading; main keeps it with whose and which
 * assistant's it is, and answers an App only when both are the ones it just verified. The App names the binding, and a row by
 * the handle it was given; it never names, nor hears, a work, session, chat, device or account id.
 */
const coded = (code: 'denied' | 'invalid' | 'failed' | 'not-found', message: string) => Object.assign(new Error(message), { code });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** The App's own page in its own view (apps-views.tsx): where the host draws a task's conversation. */
const DOCK = 'dock';

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

/**
 * Who the binding's `work` stands for, once it is so: the binding chosen by this account for this installed App, the action
 * declared and granted (`conversationBinding` refuses otherwise), and its conversation the account's private chat with its
 * own assistant and no one else. `selection` is the stored choice's own handle (host data): a new choice is a new one.
 * Null: no conversation chosen yet. `failed`: it could not be verified now.
 */
async function boundWork(extensionId: string, name: string) {
  const { token, ownerId } = await account();
  const before = extensionsService().conversationBinding(ownerId, extensionId, name, 'work');
  if (!before) return null;
  const recheck = async () => {
    await current(ownerId);
    if (extensionsService().conversationBinding(ownerId, extensionId, name, 'work')?.handle !== before.handle) throw coded('denied', 'Conversation binding changed');
  };
  const assistant = await ownAssistantOfChat(token, ownerId, before.chatId);
  await recheck();
  return { ownerId, assistantId: assistant, selection: before.handle };
}
type Bound = NonNullable<Awaited<ReturnType<typeof boundWork>>>;

/**
 * A row's handle for one App: a keyed hash of this App, this account, this choice of conversation and the row, under a key
 * that lives as long as this run of gugu. It carries nothing of the row and means nothing to another App or choice.
 */
const HANDLE_KEY = randomBytes(32);
function handleOf(extensionId: string, bound: Pick<Bound, 'ownerId' | 'selection'>, row: { workId: string; sessionId: string }): string {
  const mac = createHmac('sha256', HANDLE_KEY).update(JSON.stringify([extensionId, bound.ownerId, bound.selection, row.workId, row.sessionId]));
  return `w${mac.digest('base64url').slice(0, 22)}`;
}

/** The window's last reading of the ledger (`workLedgerChanged`); host data, never passed on as it is. */
const NO_LEDGER: PushedWorkLedger = { ownerId: null, assistantId: null, state: 'none', rows: [] };
let ledger: PushedWorkLedger = NO_LEDGER;
let pushes = 0;

const readable = (bound: Bound) => ledger.ownerId === bound.ownerId && ledger.assistantId === bound.assistantId
  && (ledger.state === 'ready' || ledger.state === 'stale');

/** What an App is told, once `bound` is verified: the rows with its own handles, and the row its panel shows. */
function answerFor(extensionId: string, name: string, bound: Bound): AppBindingWork {
  // The task drawn over its panel (app-host-layers.ts), for this account: another host page there is no row of its own.
  const shown = hostLayerOf(extensionId, bound.ownerId);
  const open = shown?.kind === 'work' ? handleOf(extensionId, bound, shown) : null;
  if (!readable(bound)) return { name, state: 'unavailable', open };
  // Newest first, as the built-in list orders them (assistant-lineage.ts `groupByDay`). Only the allowed fields, by name.
  const items: AppWorkItem[] = [...ledger.rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((row) => ({
    handle: handleOf(extensionId, bound, row),
    title: row.title,
    naming: row.naming,
    status: row.status ? { status: row.status.status, detail: row.status.detail } : null,
    unseen: row.unseen,
    updatedAt: row.updatedAt,
  }));
  return { name, state: 'ready', items, stale: ledger.state === 'stale', open };
}

const NAME_ONLY = z.strictObject({ name: z.string() });

/** `gugu.bindings.work(name)` (46, `chat:work`): the rows, or why there are none. */
export async function appBindingWork(extensionId: string, input: unknown): Promise<AppBindingWork> {
  const { name } = argsOf(NAME_ONLY, input, 'gugu.bindings.work takes the binding\'s name alone, never a chat, account or task');
  const bound = await boundWork(extensionId, name).catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable', open: null };
  if (!bound) return { name, state: 'unbound' };
  return answerFor(extensionId, name, bound);
}

/** What `onWorkChanged` hears: the same answer, a refusal heard as `unavailable` (the App learns not why). */
export async function appBindingWorkHeard(extensionId: string, name: string): Promise<AppBindingWork> {
  return appBindingWork(extensionId, { name }).catch(() => ({ name, state: 'unavailable' as const, open: null }));
}

/**
 * `gugu.bindings.openWork(name, handle)` (46, `chat:work`, in a click, from the App's own page): the window draws that row's
 * task conversation in the App's panel (`act`, which refuses an account it does not show). The row is found by the handle
 * among the rows the window last read for the verified account and assistant; a handle of another App, choice or run of gugu,
 * or of a row no longer there, is `not-found`.
 */
export async function appOpenWork(
  extensionId: string,
  page: { tabId: string },
  input: unknown,
  act: (action: ExtensionHostAction) => Promise<unknown>,
): Promise<void> {
  const { name, handle } = argsOf(z.strictObject({ name: z.string(), handle: z.string() }), input,
    'gugu.bindings.openWork takes the binding\'s name and a handle from gugu.bindings.work');
  if (!WORK_HANDLE.test(handle)) throw coded('invalid', 'A handle is one gugu.bindings.work gave this App, as it was given');
  if (page.tabId !== DOCK) throw coded('denied', 'A task\'s conversation opens in the App\'s own page, from that page');
  const bound = await boundWork(extensionId, name);
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  if (!readable(bound)) throw coded('failed', 'The work list cannot be read now: try again once gugu.bindings.onWorkChanged says it is ready');
  const row = ledger.rows.find((candidate) => handleOf(extensionId, bound, candidate) === handle);
  if (!row) throw coded('not-found', 'That task is not in the list now: read gugu.bindings.work again');
  await act({ kind: 'openWork', ownerId: bound.ownerId, workId: row.workId, sessionId: row.sessionId });
}

/** `gugu.bindings.closeWork(name)` (46): the task's conversation in the App's panel taken away; none drawn, nothing changes. */
export async function appCloseWork(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void> {
  const { name } = argsOf(NAME_ONLY, input, 'gugu.bindings.closeWork takes the binding\'s name alone');
  const { ownerId } = await account();
  // The grant and the declared binding (refused otherwise, as every other verb of it). Taking it away needs no more.
  extensionsService().conversationBinding(ownerId, extensionId, name, 'work');
  await act({ kind: 'closeWork' });
}

/** The binding whose `work` an App declared; none: it reads no work. */
export function workBindingName(manifest: ExtensionManifest): string | null {
  const binding = manifest.permissions?.bindings?.[0];
  return binding?.actions.includes('work') ? binding.name : null;
}

/** The installed Apps that declare `work`: those whose pages may need telling when the ledger or their panel changed. */
export function appsReadingWork(): string[] {
  return extensionsService().list().extensions.flatMap(({ manifest }) => (workBindingName(manifest) ? [manifest.id] : []));
}

/**
 * The window's new reading of the ledger (controller `workLedgerChanged`, the trusted renderer). Kept only as the signed-in
 * account's — a reading for any other is refused — and only the newest: one that resolves after a later push is dropped.
 * Answers the Apps to tell (none: no change). What is drawn over an App's panel is the window's own word (`reportHostLayer`).
 */
export async function workLedgerChanged(input: unknown): Promise<string[]> {
  const parsed = pushedWorkLedgerSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', 'Not a work ledger an App may see');
  const mine = ++pushes;
  if (parsed.data.ownerId !== null) {
    const { ownerId } = await account();
    if (ownerId !== parsed.data.ownerId) throw coded('denied', 'That ledger is not the signed-in account\'s');
  }
  if (mine !== pushes) return [];
  const before = JSON.stringify(ledger);
  ledger = parsed.data.ownerId === null ? NO_LEDGER : parsed.data;
  return before === JSON.stringify(ledger) ? [] : appsReadingWork();
}

/** Tests only: a window that has read nothing. */
export function forgetWorkLedgerForTest(): void {
  ledger = NO_LEDGER;
}
