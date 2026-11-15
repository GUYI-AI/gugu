import { replica } from './replica'
import { topicService } from './topics'

/** The ledger row behind one agent-flood notice (account replica, one reading per notice message). */
export const agentFloodAdjustment = replica({
  name: 'agentFloodAdjustment',
  scope: 'account',
  read: (_owner: string, messageId: string) => topicService.getAgentFloodAdjustment(messageId),
})
