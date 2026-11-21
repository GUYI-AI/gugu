import { replica } from './replica'
import { chatDb } from './supabase'
import { rendererLogger } from './log'
import { topicService } from './topics'

/** The ledger row behind one agent-flood notice (account replica, one reading per notice message). */
export const agentFloodAdjustment = replica({
  name: 'agentFloodAdjustment',
  scope: 'account',
  read: (_owner: string, messageId: string) => topicService.getAgentFloodAdjustment(messageId),
})

const floodNoticeLog = rendererLogger('chat/agent-flood-notice')

/** The system message carrying a line's agent-flood notice, or null (one per group). ❌ A failed read as "never happened": retried once after 3 s. */
export const agentFloodNotice = replica({
  name: 'agentFloodNotice',
  scope: 'account',
  read: async (_owner: string, chatId: string): Promise<string | null> => {
    const { data, error } = await chatDb
      .from('agent_flood_adjustments')
      .select('message_id')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) {
      floodNoticeLog.error({ error, chatId }, 'agent flood ledger lookup failed')
      throw new Error(error.message)
    }
    const row = (data ?? [])[0] as { message_id?: unknown } | undefined
    return typeof row?.message_id === 'string' ? row.message_id : null
  },
  retry: 1,
  retryDelay: () => 3000,
})
