type AgentRosterRecord = { cache?: Record<string, unknown> | null; ownerId?: string; status?: string | null }

// #4277 会话不带账号,但 agent 身份有主人:名册行在 cache 里记着它归哪个咕咕账号(缓存云端
// identity.users.owner_user_id 这个既有事实)。同一台机器上换账号时,别家的行**留着**(它的主人回来
// 还要用),只是本账号的运行时巡扫(标在线 / 发活动 / 刷 token / 下线)一律跳过它。
// 没记 owner 的老行登录后由 identity host 一次回填(adoptRosterOwners);回填前它不归任何账号。
export const AGENT_OWNER_CACHE_KEY = 'sessionpage_owner_user_id'

/** Every row on this machine, whoever's: only for callers that act on the roster as such (reaping, a session's own binding,
 *  boot routing before the owner is decided). Nothing else means "all": no owner is nobody's. */
export type AllAgentOwners = { readonly all: true }
export type AgentOwnerScope = string | null | undefined | AllAgentOwners

export function agentOwnerUserId(record: AgentRosterRecord | null | undefined): string {
  const value = record?.ownerId ?? record?.cache?.[AGENT_OWNER_CACHE_KEY]
  return typeof value === 'string' ? value : ''
}

/** 这行归这个账号吗:记了 owner 就比对;没记 owner、或没给账号,都不归。 */
export function agentMayBelongTo(
  record: AgentRosterRecord | null | undefined,
  ownerUserId: string | null | undefined
): boolean {
  return !!ownerUserId && agentOwnerUserId(record) === ownerUserId
}

/** 运行时巡扫的候选行:只留归这个账号的;`{ all: true }` 才是整张名册。 */
export function agentsForOwner<T extends AgentRosterRecord>(
  agents: readonly T[],
  owner: AgentOwnerScope,
  options: { includeArchived?: boolean } = {},
): T[] {
  const everyone = typeof owner === 'object' && owner !== null && owner.all === true
  return agents.filter((agent) => (everyone || agentMayBelongTo(agent, owner as string | null | undefined))
    && (options.includeArchived || agent.status !== 'archived'))
}

/** The single roster archival mutation; each host retains its existing persistence. */
export function archiveAgentRecord<T extends AgentRosterRecord>(record: T): T {
  record.status = 'archived'
  return record
}
