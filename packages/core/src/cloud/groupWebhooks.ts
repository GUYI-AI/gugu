import type { GroupAdminRpcClient } from './groupAdmin'

// #3934 群 Webhook:外部系统拿地址往群里发消息,不占账号、不算成员(设计 gugu-dev#1529,后端 gugu-supabase #420)。
// 人和 agent 共用这一份:actor 是「以谁的身份」,由已登录的 App 或可信的 MCP 会话给(❌ 模型参数),数据库只放行
// 该群的群主或管理员(owner 11-26 21:39:管理员 agent 跟人一样能建)。owner 11-26 定「随时复制」:口令随行返回。
// 指向存在 Webhook 上(owner 11-26 21:28):调地址的一方改不了;不指向就按收听规则,谁开着主动收听谁收到。

export const GROUP_WEBHOOK_NAME_MAX = 32
export const GROUP_WEBHOOK_TARGET_MAX = 20

export type GroupWebhook = {
  id: string
  chatId: string
  name: string
  token: string
  /** Members the webhook's messages point at, in the order set; empty = untargeted. */
  targetUserIds: string[]
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  disabledAt: string | null
  lastUsedAt: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

export function groupWebhookFromRow(raw: unknown): GroupWebhook {
  const row = (raw ?? {}) as Record<string, unknown>
  const id = text(row.id), chatId = text(row.chat_id), name = text(row.name), token = text(row.token), createdAt = text(row.created_at)
  const targets = row.target_user_ids
  if (!id || !chatId || !name || !token || !createdAt || !Array.isArray(targets) || targets.some((target) => !text(target))) {
    throw new Error('group webhook: database returned an incomplete row')
  }
  return {
    id, chatId, name, token, createdAt,
    targetUserIds: targets as string[],
    createdBy: text(row.created_by),
    createdByName: text(row.created_by_name),
    disabledAt: text(row.disabled_at),
    lastUsedAt: text(row.last_used_at),
  }
}

/** The address a system posts to; `/slack` after it takes Slack's incoming-webhook body. */
export function groupWebhookUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/group-webhook/${token}`
}

/** actor is supplied by the authenticated app or trusted MCP session, never a model argument. */
export function createGroupWebhooks(client: GroupAdminRpcClient, actor: string) {
  if (!actor.trim()) throw new Error('A group webhook operation requires an explicit actor')

  // Every call names its function and arguments literally, as createGroupAdmin does: the release contract gate reads
  // `.rpc('name', { keys })` from source, and a call built from variables would be one it cannot check.
  async function call(response: ReturnType<GroupAdminRpcClient['rpc']>): Promise<unknown> {
    const { data, error } = await response
    // The SQLSTATE travels with the message, as createGroupAdmin does.
    if (error) throw Object.assign(new Error(error.message), error.code ? { code: error.code } : {})
    return data
  }
  /** A function returning its table gives PostgREST an array; each change names exactly one webhook. */
  async function one(name: string, response: ReturnType<GroupAdminRpcClient['rpc']>): Promise<GroupWebhook> {
    const data = await call(response)
    const rows = Array.isArray(data) ? data : [data]
    if (rows.length !== 1) throw new Error(`${name}: database returned ${rows.length} rows`)
    return groupWebhookFromRow(rows[0])
  }

  return {
    async list(chatId: string): Promise<GroupWebhook[]> {
      const data = await call(client.rpc('group_webhooks_list', { p_chat_id: chatId, p_as_user_id: actor }))
      if (!Array.isArray(data)) throw new Error('group_webhooks_list: database returned no list')
      return data.map(groupWebhookFromRow)
    },
    create: (chatId: string, name: string, targetUserIds: readonly string[]) =>
      one('group_webhook_create', client.rpc('group_webhook_create', { p_chat_id: chatId, p_name: name, p_target_user_ids: [...targetUserIds], p_as_user_id: actor })),
    /** Omitted fields keep their value; an empty target list makes the webhook untargeted. */
    update: (webhookId: string, change: { name?: string; targetUserIds?: readonly string[] }) =>
      one('group_webhook_update', client.rpc('group_webhook_update', { p_webhook_id: webhookId, p_name: change.name ?? null,
        p_target_user_ids: change.targetUserIds ? [...change.targetUserIds] : null, p_as_user_id: actor })),
    setDisabled: (webhookId: string, disabled: boolean) =>
      one('group_webhook_set_disabled', client.rpc('group_webhook_set_disabled', { p_webhook_id: webhookId, p_disabled: disabled, p_as_user_id: actor })),
    rotate: (webhookId: string) => one('group_webhook_rotate', client.rpc('group_webhook_rotate', { p_webhook_id: webhookId, p_as_user_id: actor })),
    remove: (webhookId: string) => one('group_webhook_delete', client.rpc('group_webhook_delete', { p_webhook_id: webhookId, p_as_user_id: actor })),
  }
}

export type GroupWebhooks = ReturnType<typeof createGroupWebhooks>
