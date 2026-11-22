// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'
import { usePhoneInterruptedRetry } from '../../../apps/desktop/src/components/session-watch/usePhoneInterruptedRetry'
import { state } from '../../../apps/desktop/src/lib/outbox/kinds/sessionInput'

const scope = vi.hoisted(() => ({ invoke: vi.fn(), notices: new Map<string | number, string>() }))
vi.mock('../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: scope.invoke }))
vi.mock('sonner', () => {
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? 'interrupted-retry'; scope.notices.set(id, title); return id }
  return { toast: Object.assign(show, { error: show, info: show, success: show, warning: show, dismiss: (id: string | number) => scope.notices.delete(id) }) }
})
vi.mock('../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))

let ui: ReturnType<typeof createReactHarness>, commands: ReturnType<typeof usePhoneInterruptedRetry>
function Fixture({ enabled = true, session = 'session' }: { enabled?: boolean; session?: string }) {
  commands = usePhoneInterruptedRetry(enabled, 'phone-device', session)
  return null
}
beforeEach(() => { ui = createReactHarness(); scope.invoke.mockReset(); scope.notices.clear(); state().accountId = 'owner' })
afterEach(() => { ui.cleanup(); state().accountId = null })

it('opening and rerendering do not replay interrupted work; a tap uses original job custody', async () => {
  scope.invoke.mockResolvedValue({ accepted: true })
  await ui.render(<Fixture />); await ui.render(<Fixture />)
  expect(scope.invoke).not.toHaveBeenCalled()
  expect(commands.canRetryPhoneTask?.('original')).toBe(true)
  await act(async () => { expect(await commands.onRetryPhoneTask?.({ itemId: 'row', jobId: 'original' })).toBe(true) })
  expect(scope.invoke).toHaveBeenCalledExactlyOnceWith('phone-device', 'sessionTimeline.sessionRetry', [{ conversationId: 'session', jobId: 'original' }])
  expect(commands.canRetryPhoneTask?.('original')).toBe(false)
  expect(commands.canRetryPhoneTask?.('another')).toBe(true)
  await ui.render(<Fixture session="another-session" />)
  expect(commands.canRetryPhoneTask?.('original')).toBe(true)
  expect(scope.invoke).toHaveBeenCalledTimes(1)
})

it('a rejected retry stays available and reports through the existing failure outlet', async () => {
  scope.invoke.mockRejectedValue(new Error('Native execution unavailable'))
  await ui.render(<Fixture />)
  await act(async () => { expect(await commands.onRetryPhoneTask?.({ itemId: 'row', jobId: 'original' })).toBe(false) })
  expect(commands.canRetryPhoneTask?.('original')).toBe(true)
  expect(scope.notices.size).toBe(1)
  scope.invoke.mockResolvedValue({ accepted: true })
  await act(async () => { await commands.onRetryPhoneTask?.({ itemId: 'row', jobId: 'original' }) })
  expect(scope.notices.size).toBe(0)
})

it('computer-hosted conversations expose no phone retry capability', async () => {
  await ui.render(<Fixture enabled={false} />)
  expect(commands.onRetryPhoneTask).toBeUndefined()
  expect(commands.canRetryPhoneTask).toBeUndefined()
  expect(scope.invoke).not.toHaveBeenCalled()
})
