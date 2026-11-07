// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const visible = vi.hoisted(() => new Map<string, string>())
vi.mock('sonner', () => {
  const show = (title: string, options: { id: string }) => { visible.set(options.id, title); return options.id }
  return { toast: Object.assign(show, { error: show, success: show, warning: show, info: show,
    dismiss: (id: string) => { visible.delete(id) } }) }
})
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
import { messageFailureNotice } from '../../../../apps/desktop/src/lib/messageFailureNotice'
afterEach(() => visible.clear())

it('an old success cannot clear a newer failed attempt, and an old error cannot reopen a successful send', () => {
  const failure = messageFailureNotice(['im', 'owner', 'chat', 'message'])
  const first = failure.begin()
  first.failed({ title: 'first failure', tier: 'error' })
  const retry = failure.begin()
  retry.failed({ title: 'retry failed', tier: 'error' })
  expect([...visible.values()]).toEqual(['retry failed'])
  first.succeeded()
  expect([...visible.values()]).toEqual(['retry failed'])
  retry.succeeded()
  first.failed({ title: 'late failure', tier: 'error' })
  expect(visible.size).toBe(0)
})

it('identical text in other messages, accounts and conversations has independent ownership', () => {
  const owners = [['im', 'owner', 'chat', 'a'], ['im', 'owner', 'chat', 'b'],
    ['im', 'other-owner', 'chat', 'a'], ['acp', 'host', 'task', 'a']] as const
  const attempts = owners.map(owner => messageFailureNotice(owner).begin())
  attempts.forEach(attempt => attempt.failed({ title: 'same error and message text', tier: 'error' }))
  expect(visible.size).toBe(4)
  attempts[0].succeeded()
  expect(visible.size).toBe(3)
})

it('a new producer of the same message supersedes the old producer without affecting another message', () => {
  const owner = ['im', 'owner', 'chat', 'cross-root-message'] as const
  const old = messageFailureNotice(owner).begin()
  old.failed({ title: 'old', tier: 'error' })
  const retry = messageFailureNotice(owner).begin()
  retry.failed({ title: 'retry', tier: 'error' })
  old.succeeded()
  expect([...visible.values()]).toEqual(['retry'])
  retry.succeeded()
  expect(visible.size).toBe(0)
})
