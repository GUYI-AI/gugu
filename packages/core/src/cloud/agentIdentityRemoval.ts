/** At most this many identities per `purge_owned_agent_history` call (the backend rejects more). */
export const PURGE_HISTORY_BATCH = 50

export const PERMANENT_REMOVAL_RPCS = { agent: 'remove_owned_agent', device: 'remove_device', history: 'purge_owned_agent_history' } as const

/** The retained identity row is the removal fact; membership rows are never written here. */
export async function archiveIdentity(client: {
  rpc(name: 'archive_user', args: { p_user_id: string; p_remove_social_identity: boolean }): PromiseLike<{ data: unknown; error: { message: string } | null }>
}, userId: string, removeSocialIdentity = true): Promise<{ userId: string; removedAt: string | null }> {
  const { data, error } = await client.rpc('archive_user', { p_user_id: userId, p_remove_social_identity: removeSocialIdentity })
  if (error) throw new Error(error.message, { cause: error })
  const receipt = data as { user_id?: unknown; removed_at?: unknown; remove_social_identity?: unknown } | null
  if (receipt?.user_id !== userId || receipt.remove_social_identity !== removeSocialIdentity
    || (removeSocialIdentity ? typeof receipt.removed_at !== 'string' || !Number.isFinite(Date.parse(receipt.removed_at)) : receipt.removed_at !== null)) {
    throw new Error('Identity archival receipt does not match the requested identity and option')
  }
  return { userId, removedAt: receipt.removed_at as string | null }
}

/**
 * 「已归档」里的永久删除(owner 2026-11-26):删掉这些已移除身份的私聊历史(只有 owner 和它的私聊连同消息、
 * 文件夹,会话附件、拒投区间、绑定、定时任务);身份行留作墓碑,群里它发过的消息保留、发送者显示「已移除」。
 * 后端只认已经 `removed_at` 的身份(还在的报 55000:先 archive_user(true)),一次 1–50 个,重放结果不变。
 */
export async function purgeOwnedAgentHistory(client: {
  rpc(name: typeof PERMANENT_REMOVAL_RPCS.history, args: { p_agent_user_ids: string[] }): PromiseLike<{ data: unknown; error: { message: string } | null }>
}, agentUserIds: readonly string[]): Promise<{ purged: string[]; conversations: number }> {
  const ids = [...new Set(agentUserIds.filter(Boolean))]
  if (ids.length < 1 || ids.length > PURGE_HISTORY_BATCH) throw new Error(`purgeOwnedAgentHistory takes 1 to ${PURGE_HISTORY_BATCH} agent ids`)
  // Literal name and argument keys on purpose: the release contract gate only reads `.rpc('name', { key })`; the
  // parameter type above ties this spelling to PERMANENT_REMOVAL_RPCS.history, so a rename fails to compile here.
  const { data, error } = await client.rpc('purge_owned_agent_history', { p_agent_user_ids: ids })
  if (error) throw new Error(error.message, { cause: error })
  const receipt = data as { purged?: unknown; conversations?: unknown } | null
  if (!Array.isArray(receipt?.purged) || receipt.purged.some(id => typeof id !== 'string' || !ids.includes(id))
    || typeof receipt.conversations !== 'number') {
    throw new Error('History purge receipt does not match the requested identities')
  }
  return { purged: receipt.purged as string[], conversations: receipt.conversations }
}

type RemovalResult = PromiseLike<{ error: { message: string } | null }>
type AgentRemoval = { agentId: string; client: { rpc(name: 'remove_owned_agent', args: { p_agent_user_id: string }): RemovalResult } }
type DeviceRemoval = { deviceId: string; cascade?: boolean; client: { rpc(name: 'remove_device', args: { p_device_id: string; p_cascade: boolean }): RemovalResult } }

/** Explicit permanent removal. Callers use their existing confirmation UI and backend authorization. */
export async function permanentlyRemove(target: AgentRemoval | DeviceRemoval): Promise<void> {
  const { error } = 'agentId' in target
    ? await target.client.rpc('remove_owned_agent', { p_agent_user_id: target.agentId })
    : await target.client.rpc('remove_device', { p_device_id: target.deviceId, p_cascade: target.cascade ?? false })
  if (error) throw new Error(error.message, { cause: error })
}
