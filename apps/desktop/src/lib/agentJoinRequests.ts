import { chatService } from './chat'
import { replica } from './replica'

/**
 * The join requests I made for my agents into one group: one reading per group, shared by its task cards and the add
 * page (each card used to read them itself). Refreshes join a read already on its way: one revision event, one read.
 */
export const myAgentJoinRequests = replica({
  name: 'myAgentJoinRequests',
  scope: 'account',
  read: (_owner: string, chatId: string) => chatService.listMyAgentJoinRequests(chatId),
  refreshJoinsRead: true,
})
