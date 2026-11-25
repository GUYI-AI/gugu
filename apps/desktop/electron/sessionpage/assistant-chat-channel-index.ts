import { z } from 'zod'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { AssistantLocalSource } from './assistant-local-index'

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
