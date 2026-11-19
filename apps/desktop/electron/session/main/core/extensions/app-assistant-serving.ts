import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';
import type { ReadFailureReason } from '@shared/extensions/resources-management';

/**
 * Kept apart from the checks that read the rest of the account (app-bound-resources.ts, app-assistant-binding.ts), which both
 * stand on it: two checks of "is this the person's assistant's chat", asked at different moments, must not disagree about
 * when the assistant is ready.
 */
const failed = (message: string, reason: ReadFailureReason = 'unreadable') => Object.assign(new Error(message), { code: 'failed', reason });

// What `pickAssistant` reads (ASSISTANT_PROVISION_SELECT), plus the private conversation and the identity's owner.
const PERSONAL_ASSISTANT_SELECT = 'agent_user_id,device_id,member_key,phase,created_at,dm_chat_id,agent:users!agent_provisions_agent_user_id_fkey(owner_user_id,removed_at)';

/**
 * What the conversation is to the signed-in person's personal assistant — the one the assistant's own pages show
 * (`pickAssistant`, as `personalAssistant` picks it), owned and not removed:
 * - `served`: the assistant's provision names this very conversation as its private one, in a phase the store serves
 *   (ready or completed, as `assistant_panel_is_owner` asks). Only then has the assistant panel resources to give.
 * - `pending`: the same, but its setup is still under way (queued, preparing, waiting for its terminal) and the conversation is
 *   the one it will have, or is not named yet. A conversation that exists before its assistant is ready is not a refusal.
 * - `none`: anything else — another of the person's agents, someone else's, a group, a person, no assistant at all.
 * `failed` (thrown): it could not be verified now, never "none".
 */
export type AssistantServing = { state: 'served'; agentId: string; deviceId: string } | { state: 'pending' } | { state: 'none' };
const SERVED_PHASES = ['ready', 'completed'];
export async function assistantServingChat(token: string, ownerId: string, chatId: string): Promise<AssistantServing> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('agent_provisions').select(PERSONAL_ASSISTANT_SELECT)
    .eq('owner_user_id', ownerId).eq('member_key', 'assistant').limit(32).abortSignal(AbortSignal.timeout(5000));
  if (error) throw failed('Could not verify the agent of the chosen conversation', 'owner-unknown');
  type Identity = { owner_user_id?: unknown; removed_at?: unknown };
  type Row = Omit<AssistantProvisionRow, 'agent'> & { dm_chat_id?: unknown; agent: Identity | Identity[] | null };
  const rows = (data ?? []) as Row[];
  let pick: ReturnType<typeof pickAssistant>;
  try {
    // Its own check of each identity: exactly one, its removal said (null or a time), else it throws.
    pick = pickAssistant(rows as AssistantProvisionRow[]);
  } catch {
    throw failed('Could not verify the agent of the chosen conversation', 'owner-unknown');
  }
  if (!pick) return { state: 'none' };
  const mine = rows.filter((row) => {
    const agent = Array.isArray(row.agent) ? row.agent.length === 1 ? row.agent[0] : null : row.agent;
    return row.agent_user_id === pick.agentId && row.member_key === 'assistant' && agent?.owner_user_id === ownerId && agent.removed_at === null;
  });
  if (mine.some((row) => row.dm_chat_id === chatId && SERVED_PHASES.includes(String(row.phase)))) return { state: 'served', ...pick };
  if (mine.some((row) => !SERVED_PHASES.includes(String(row.phase)) && (row.dm_chat_id === chatId || row.dm_chat_id == null))) return { state: 'pending' };
  return { state: 'none' };
}

