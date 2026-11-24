import type { AgentProvision } from './types/agentProvision';

// The assistant setup flow still creates the agent through a provision marker (`member_key='assistant'`); the database
// binds the agent it creates to the assistant App. These describe that marker, for the setup and close flows only.
export const ASSISTANT_PROVISION_SELECT = 'agent_user_id,device_id,member_key,phase,created_at,agent:users!agent_provisions_agent_user_id_fkey(removed_at)';
type ProvisionIdentity = { removed_at: string | null };
export type AssistantProvisionRow = Pick<AgentProvision, 'agent_user_id' | 'device_id' | 'member_key' | 'phase' | 'created_at'> & {
  // Untyped PostgREST clients infer embedded relations as arrays. Accept either
  // representation, but require exactly one identity before trusting its state.
  agent: ProvisionIdentity | ProvisionIdentity[] | null;
};
export function provisionIdentityRemovedAt(row: Pick<AssistantProvisionRow, 'agent'>): string | null | undefined {
  const identity = Array.isArray(row.agent) ? row.agent.length === 1 ? row.agent[0] : null : row.agent;
  return identity?.removed_at;
}

/** The App the personal assistant is: the person's assistant is whichever agent this App is bound to on the account. */
export const ASSISTANT_APP_ID = 'gugu-assistant';
/** `identity.my_app_agent` with these args: the caller's live agent bound to the assistant App, and the device it lives on. */
export const ASSISTANT_BINDING_RPC = 'my_app_agent';
export const ASSISTANT_BINDING_ARGS = { p_app_id: ASSISTANT_APP_ID } as const;
export type AssistantPick = { agentId: string; deviceId: string };

/** The rows `my_app_agent` returns (none or one) as the assistant; anything else is not a reading. */
export function pickAssistant(rows: unknown): AssistantPick | null {
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Could not verify the personal assistant identity');
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (!row || typeof row !== 'object') throw new Error('Could not verify the personal assistant identity');
  const { agent_user_id, device_id } = row as { agent_user_id?: unknown; device_id?: unknown };
  if (typeof agent_user_id !== 'string' || !agent_user_id.trim() || typeof device_id !== 'string' || !device_id.trim()) throw new Error('Could not verify the personal assistant identity');
  return { agentId: agent_user_id, deviceId: device_id };
}
