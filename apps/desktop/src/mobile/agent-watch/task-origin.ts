import type { SessionpageSessionCreateRequest } from '@gugu/session-core/session-record/contract'

/** The group grants membership; an optional topic is the fixed place the task was started. */
export type TaskGroupOrigin = { chatId: string; name: string; topic?: { chatId: string; name: string } }

/** A recovered request keeps its own destination, even when opened from another conversation. */
export function taskOriginOfRequest(request: Pick<SessionpageSessionCreateRequest, 'chatId' | 'taskChatId'> | null, current: TaskGroupOrigin | null): TaskGroupOrigin | null {
  if (!request) return current
  if (!request.chatId || !request.taskChatId) return null
  return { chatId: request.chatId, name: current?.chatId === request.chatId ? current.name : '',
    ...(request.taskChatId !== request.chatId ? { topic: { chatId: request.taskChatId,
      name: current?.topic?.chatId === request.taskChatId ? current.topic.name : '' } } : {}) }
}
