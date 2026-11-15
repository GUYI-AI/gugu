import { expect, it } from 'vitest'
import { taskOriginOfRequest } from '../../../apps/desktop/src/mobile/agent-watch/task-origin'

const current = { chatId: 'group', name: 'Group', topic: { chatId: 'new-topic', name: 'New topic' } }
it('keeps a recovered request in its original topic instead of the topic now on screen', () => {
  expect(taskOriginOfRequest({ chatId: 'old-group', taskChatId: 'old-topic' }, current))
    .toEqual({ chatId: 'old-group', name: '', topic: { chatId: 'old-topic', name: '' } })
})
it('does not attach the current topic to an ordinary or group request', () => {
  expect(taskOriginOfRequest({}, current)).toBeNull()
  expect(taskOriginOfRequest({ chatId: 'group', taskChatId: 'group' }, current)).toEqual({ chatId: 'group', name: 'Group' })
  expect(taskOriginOfRequest(null, current)).toBe(current)
})
