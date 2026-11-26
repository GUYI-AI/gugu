/** Test fakes of `my_app_agent` over provision-shaped fixtures: the live assistant marker is the bound agent, as the backfill reads it. */
type Fixture = { agent_user_id?: unknown; device_id?: unknown; member_key?: unknown; phase?: unknown; created_at?: unknown; agent?: unknown };
const GONE = ['failed', 'cancelling', 'cancelled'];
const removedAt = (row: Fixture) => {
  const agent = (Array.isArray(row.agent) ? row.agent[0] : row.agent) as { removed_at?: unknown } | null | undefined;
  return agent?.removed_at ?? null;
};
export function boundRows(rows: readonly Fixture[] | null | undefined) {
  return [...(rows ?? [])]
    .filter((row) => row.member_key === 'assistant' && typeof row.agent_user_id === 'string' && !GONE.includes(String(row.phase)) && removedAt(row) === null)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 1)
    .map((row) => ({ agent_user_id: row.agent_user_id, device_id: row.device_id }));
}
/** Adds `rpc('my_app_agent')` to a fake client whose `from('agent_provisions')` answers the fixtures. */
export function withBindingRpc<T extends { from(table: string): unknown }>(client: T, scope: (query: any) => unknown = (query) => query) {
  return {
    ...client,
    rpc: () => {
      const run = () => Promise.resolve(scope(client.from('agent_provisions')) as PromiseLike<{ data: unknown; error: unknown }>)
        .then((read) => read.error ? read : { data: boundRows(read.data as Fixture[]), error: null });
      const query: Record<string, unknown> = {
        abortSignal: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
      };
      return query;
    },
  };
}
/**
 * A fake `assistantServingChat` over the same fixtures: served when the bound agent's fixture names this chat as its private
 * one (`dm_chat_id`) for this owner; unreadable fixtures fail as the real check does.
 */
export function servingOf(rows: readonly (Fixture & { dm_chat_id?: unknown })[], ownerId: string, chatId: string, unreadable = false) {
  if (unreadable) throw Object.assign(new Error('Could not verify the agent of the chosen conversation'), { code: 'failed', reason: 'owner-unknown' });
  const [bound] = boundRows(rows);
  const own = rows.find((row) => row.agent_user_id === bound?.agent_user_id && row.member_key === 'assistant' && row.dm_chat_id === chatId);
  const owner = (Array.isArray(own?.agent) ? own?.agent[0] : own?.agent) as { owner_user_id?: unknown } | undefined;
  return bound && own && (owner?.owner_user_id ?? ownerId) === ownerId
    ? { state: 'served' as const, agentId: String(bound.agent_user_id), deviceId: String(bound.device_id) }
    : { state: 'none' as const };
}
