import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, pickAssistant } from '@gugu/core/shared/assistantProvision';
import type { ReadFailureReason } from '@shared/extensions/resources-management';

/**
 * Kept apart from the checks that read the rest of the account (app-bound-resources.ts, app-assistant-binding.ts), which both
 * stand on it: two checks of "is this the person's assistant's chat", asked at different moments, must not disagree.
 */
const failed = (message: string, reason: ReadFailureReason = 'unreadable') => Object.assign(new Error(message), { code: 'failed', reason });

/**
 * What the conversation is to the signed-in person's personal assistant — the agent the assistant App is bound to on the
 * account (`my_app_agent`), as the assistant's own pages and the store's guard (`assistant_panel_is_owner`) read it:
 * - `served`: the conversation is the private one between the person and that agent, and no one else.
 * - `none`: anything else — another of the person's agents, someone else's, a group, a person, no assistant at all.
 * `failed` (thrown): it could not be verified now, never "none".
 */
export type AssistantServing = { state: 'served'; agentId: string; deviceId: string } | { state: 'none' };
export async function assistantServingChat(token: string, ownerId: string, chatId: string): Promise<AssistantServing> {
  const headers = { Authorization: `Bearer ${token}` };
  const identity = createGuguSupabaseClient({ schema: 'identity', headers });
  const chat = createGuguSupabaseClient({ schema: 'chat', headers });
  const timeout = AbortSignal.timeout(5000);
  const [bound, room, members] = await Promise.all([
    identity.rpc(ASSISTANT_BINDING_RPC, ASSISTANT_BINDING_ARGS).abortSignal(timeout),
    chat.from('chats').select('kind').eq('id', chatId).abortSignal(timeout).maybeSingle(),
    chat.from('active_members').select('user_id').eq('chat_id', chatId).abortSignal(timeout),
  ]);
  if (bound.error || room.error || members.error) throw failed('Could not verify the agent of the chosen conversation', 'owner-unknown');
  let pick: ReturnType<typeof pickAssistant>;
  try {
    pick = pickAssistant(bound.data);
  } catch {
    throw failed('Could not verify the agent of the chosen conversation', 'owner-unknown');
  }
  if (!pick) return { state: 'none' };
  const people = new Set(((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id));
  const kind = (room.data as { kind?: string } | null)?.kind;
  return kind === 'dm' && people.size === 2 && people.has(ownerId) && people.has(pick.agentId) ? { state: 'served', ...pick } : { state: 'none' };
}

