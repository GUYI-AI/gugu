import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, pickAssistant } from '@gugu/core/shared/assistantProvision';

/** The agent the owner's assistant App is bound to, never a display name or a directory-name guess. */
async function boundAssistantId(auth: { accessToken: string }): Promise<string | null> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const { data, error } = await client.rpc(ASSISTANT_BINDING_RPC, ASSISTANT_BINDING_ARGS).abortSignal(AbortSignal.timeout(2000));
  if (error) throw new Error('ASSISTANT_ROLE_UNAVAILABLE');
  try { return pickAssistant(data)?.agentId ?? null; } catch { throw new Error('ASSISTANT_ROLE_UNAVAILABLE'); }
}

export async function isPersonalAssistantAgent(auth: { userId: string; accessToken: string }, agentId: string): Promise<boolean> {
  return (await boundAssistantId(auth)) === agentId;
}

/** Resolve restored local bindings by the same binding, including directories outside app-owned paths. */
export async function personalAssistantSessionBindings(
  auth: { userId: string; accessToken: string },
  roster: readonly { gugu_user_id?: string | null; cache?: Record<string, unknown> | null }[],
): Promise<{ assistantId: string; sessionId: string }[]> {
  const bound = await boundAssistantId(auth);
  const ids = new Set(bound ? [bound] : []);
  const found = new Set<string>();
  return roster.flatMap(record => {
    const id = record.gugu_user_id, sessionId = record.cache?.emdash_session_id;
    if (!id || !ids.has(id) || typeof sessionId !== 'string' || !sessionId) return [];
    if (found.has(id)) throw new Error('ASSISTANT_BINDING_AMBIGUOUS');
    found.add(id);
    return [{ assistantId: id, sessionId }];
  });
}
