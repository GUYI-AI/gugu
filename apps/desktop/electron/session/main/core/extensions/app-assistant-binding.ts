import { z } from 'zod';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { ASSISTANT_PROVISION_SELECT, pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';
import {
  ASSISTANT_SCREENS,
  ASSISTANT_SETUP_ADVANCES,
  pushedAssistantStatusSchema,
  setupAdvanceAllowed,
  type AppAssistantRead,
  type AssistantBindingAction,
  type PushedAssistantStatus,
} from '@shared/extensions/assistant-binding';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';
import { currentAccountAccessToken } from './account-token';
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

/** `gugu.assistant.status(name)` (44, `assistant:status`): the snapshot, or why there is none. */
export async function appAssistantStatus(extensionId: string, input: unknown): Promise<AppAssistantRead> {
  const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.assistant.status takes the binding\'s name alone');
  const bound = await boundAssistant(extensionId, name, 'assistant-status').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { name, state: 'unavailable' };
  if (!bound) return { name, state: 'unbound' };
  const status = statusFor(bound.ownerId);
  return status ? { name, state: 'ready', status } : { name, state: 'unavailable' };
}

/**
 * `gugu.assistant.open(name, screen)` (44, `assistant:open`, in a click): the window opens that screen by its existing
 * entry (`act`). Answered done or refused; nothing of what the person does there.
 */
export async function appAssistantOpen(extensionId: string, input: unknown, act: (action: ExtensionHostAction) => Promise<unknown>): Promise<void> {
  const { name, screen } = argsOf(z.strictObject({ name: z.string(), screen: z.enum(ASSISTANT_SCREENS) }), input,
    `gugu.assistant.open takes the binding's name and one of ${ASSISTANT_SCREENS.join(', ')}`);
  const bound = await boundAssistant(extensionId, name, 'assistant-open');
  if (!bound) throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
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
 * The window's assistant changed (controller `assistantStatusChanged`): kept, and each App granted `assistant:status`
 * whose binding is still the account's chat with its own assistant hears it (`hear`: that App's pages the person works).
 * An App refused, withdrawn, disabled or removed hears nothing — checked for each change, as a read is.
 */
export async function assistantStatusChanged(input: unknown, hear: (extensionId: string, event: ExtensionHostEvent) => void): Promise<void> {
  const parsed = pushedAssistantStatusSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', 'Not an assistant snapshot an App may see');
  const same = shown?.ownerId === parsed.data.ownerId && JSON.stringify(shown.status) === JSON.stringify(parsed.data.status);
  shown = parsed.data;
  if (same) return;
  const service = extensionsService();
  await Promise.all(service.list().extensions.map(async ({ manifest }) => {
    const name = manifest.permissions?.bindings?.[0]?.name;
    if (!name || !manifest.permissions?.bindings?.[0]?.actions.includes('assistant-status')) return;
    if (!service.isEnabled(manifest.id) || !service.hasCapability(manifest.id, 'assistant:status')) return;
    const bound = await boundAssistant(manifest.id, name, 'assistant-status').catch(() => null);
    // The newest snapshot, after the wait: an older one never lands over it.
    const status = bound ? statusFor(bound.ownerId) : null;
    if (status) hear(manifest.id, { type: 'assistantChanged', name, state: 'ready', status });
  }));
}

/** Tests only: a window that has shown nothing. */
export function forgetShownAssistantForTest(): void {
  shown = null;
}
