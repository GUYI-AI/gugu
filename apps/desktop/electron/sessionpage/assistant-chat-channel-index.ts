import { z } from 'zod'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { AssistantLocalSource } from './assistant-local-index'

export const ASSISTANT_CHAT_CHANNEL_TIMEOUT_MS = 1_500

const channelsSchema = z.object({ channels: z.array(z.object({
  kind: z.enum(['wechat', 'feishu', 'dingtalk', 'telegram']),
  agentId: z.string().nullable(), isDefault: z.boolean(), connectedAt: z.string(),
  health: z.object({ state: z.enum(['starting', 'running', 'paused', 'retrying', 'broken']) }),
})).max(4) })
const names = { wechat: 'WeChat / 微信', feishu: 'Feishu / 飞书', dingtalk: 'DingTalk / 钉钉', telegram: 'Telegram' }

/** Channel metadata only. Account labels, messages and login material never enter model context. */
export async function assistantChatChannelItems(
  list: () => Promise<ChatChannelList>, assistantAgentId: string,
): Promise<NonNullable<AssistantLocalSource['items']>> {
  const { channels } = channelsSchema.parse(await list())
  return channels.map(channel => ({
    id: channel.kind, name: names[channel.kind], modifiedAt: channel.connectedAt, isDefault: channel.isDefault,
    note: JSON.stringify({ kind: channel.kind, health: channel.health.state,
      bound_to_this_assistant: channel.agentId === assistantAgentId,
      bound_to_other_agent: channel.agentId !== null && channel.agentId !== assistantAgentId }),
  }))
}

/** One assistant/owner scope; coalesce the startup hook and background discovery.
 * Rejections remain failures for the short TTL rather than becoming empty inventories.
 */
export function createAssistantChatChannelReader(options: {
  accountId(): Promise<string | null>
  expectedOwner: string
  assistantAgentId: string
  list(): Promise<ChatChannelList>
  now?: () => number
  ttlMs?: number
}): () => Promise<NonNullable<AssistantLocalSource['items']>> {
  let cached: { expiresAt: number; result: ReturnType<typeof assistantChatChannelItems> } | undefined
  return async () => {
    if (await options.accountId() !== options.expectedOwner) {
      cached = undefined
      throw new Error('Assistant channel resource owner changed')
    }
    const now = options.now?.() ?? Date.now()
    if (!cached || now >= cached.expiresAt) {
      cached = { expiresAt: now + (options.ttlMs ?? 15_000),
        result: assistantChatChannelItems(options.list, options.assistantAgentId) }
    }
    try {
      const result = await cached.result
      if (await options.accountId() !== options.expectedOwner) {
        cached = undefined
        throw new Error('Assistant channel resource owner changed')
      }
      return result.map(item => ({ ...item }))
    } catch (error) {
      if (await options.accountId() !== options.expectedOwner) cached = undefined
      throw error
    }
  }
}
