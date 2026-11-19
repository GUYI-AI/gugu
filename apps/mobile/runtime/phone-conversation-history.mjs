import { historyTime } from '../../../packages/core/src/shared/conversationHistoryTime.ts'

/** The account projection is authoritative; offline reads retain only a previously observed boundary. */
export function createPhoneConversationHistory({ cloud, store, ownerId }) {
  const reading = new Map()
  return agent => {
    if (!agent.chatId) return Promise.resolve(null)
    if (reading.has(agent.chatId)) return reading.get(agent.chatId)
    const read = (async () => {
      const cached = agent.historyFloorCache
      try {
        const rows = await cloud.rpc('chat', 'list_conversation_memberships', { p_chat_ids: [agent.chatId] })
        const own = Array.isArray(rows) && rows.find(row => row.chat_id === agent.chatId && row.user_id === ownerId)
        if (!own || !('conversation_cleared_at' in own)) throw new Error('phone conversation history state was not confirmed')
        const incoming = own.conversation_cleared_at
        if (incoming != null) historyTime(incoming)
        const floor = cached?.floor && (!incoming || historyTime(cached.floor) > historyTime(incoming)) ? cached.floor : incoming ?? null
        if (!cached || cached.floor !== floor) { agent.historyFloorCache = { floor }; await store.save() }
        return floor
      } catch (error) {
        if (cached && /fetch failed|failed to fetch|network|timeout/i.test(String(error))) return cached.floor
        throw error
      }
    })().finally(() => reading.delete(agent.chatId))
    reading.set(agent.chatId, read)
    return read
  }
}
