import { useMemo } from 'react'
import { useChatStore } from '../store/chatContext'
import { ownerPresenceChannel, useAgentPresenceChannel } from '../lib/agentPresenceChannels'

// 主人频道:我名下每个 agent 的状态变化都到这里,登录期间一直订着。我自己的 agent(会话列表行、和它的单聊、会话页)
// 都读它;群里的 agent 由打开的那个群自己的频道带(ChatAreaPanel → useAgentDisplayStatuses)。
// 挂在 provider 外、通过公开 context 读:它消费会话列表认识的身份,不是会话列表的职责。
export function AgentPresenceOwnerChannel({ userId }: { userId: string | null }) {
  const { identitiesById } = useChatStore('identitiesById')
  const ownAgentIds = useMemo(() => Object.values(identitiesById)
    .filter((identity) => identity.type === 'agent' && identity.owner_user_id === userId)
    .map((identity) => identity.id), [identitiesById, userId])
  useAgentPresenceChannel(userId ? ownerPresenceChannel(userId) : null, ownAgentIds)
  return null
}
