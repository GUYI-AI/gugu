// @vitest-environment jsdom
// A running turn republishes its session's summary with every streamed chunk (its last message, activity); here the title
// stands in for those. A reader of other fields (the task page's read and notification hooks, the sidebar's count) must not
// re-render with it.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { useConversationSessionSummary } from '../../../../apps/desktop/src/hooks/useConversationSessionSummary'

const summary = (title: string, unread: number) => ({
  conversationId: 'session-1', projectId: 'project-1', title, harness: 'codex', runtime: 'acp' as const,
  agentStatus: null, lastInteractedAt: null, supported: true, nativeOwnerNotificationUnreadCount: unread,
})
const publish = (title: string, unread = 0) => updateDeviceSessions('device-1', { sessions: [summary(title, unread)], cached: false, loading: false, error: null })

let harness: ReturnType<typeof createReactHarness>
let renders = 0
const seen: number[] = []
function Reader() {
  renders++
  seen.push(useConversationSessionSummary('session-1', 'device-1', (current) => current?.nativeOwnerNotificationUnreadCount ?? 0))
  return null
}
beforeEach(() => { harness = createReactHarness(); renders = 0; seen.length = 0; publish('') })
afterEach(() => { harness.cleanup(); removeDeviceSessions('device-1') })

it('streamed chunks re-render no reader of other fields; a change of the picked field does', async () => {
  await harness.render(createElement(Reader))
  const before = renders
  for (const chunk of ['He', 'Hello', 'Hello, wor', 'Hello, world']) await act(async () => { publish(chunk) })
  expect(renders, 'four republishes that change only what the reader does not pick').toBe(before)
  await act(async () => { publish('Hello, world', 2) })
  expect(seen.at(-1)).toBe(2)
  expect(renders).toBe(before + 1)
})
