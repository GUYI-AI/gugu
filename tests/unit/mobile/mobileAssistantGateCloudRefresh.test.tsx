// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'

/**
 * The phone's 「咕咕」 guide over a kept 管家 snapshot whose read again failed: the guide stays (❌ unmounted, #7429), and the
 * failure is said with a retry (❌ the old snapshot read as current, the cloud choice saying 「没开放」 as if known).
 */
const world = vi.hoisted(() => ({ cloud: null as unknown, refresh: vi.fn(async () => undefined) }))
vi.mock('@/lib/cloudComputer', () => ({
  useCloudComputer: () => world.cloud,
  cloudComputer: { refresh: world.refresh },
  canSetUpCloudAssistant: () => false,
}))
vi.mock('@/components/assistant/AssistantOnboarding', () => ({ AssistantOnboarding: () => <div data-testid="onboarding-guide" /> }))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'gate-owner' } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))

const { MobileAssistantGate } = await import('../../../apps/desktop/src/mobile/assistant/MobileAssistantGate')

const snapshot = { deviceId: null } as never
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); world.refresh.mockClear() })
afterEach(() => h.cleanup())
const render = () => h.render(<MobileAssistantGate stage={{ stage: 'onboarding', snapshot }} name={null} ownerName={null} />)

it('says a failed read again over the kept snapshot beside the guide, with a retry', async () => {
  world.cloud = { state: 'value', value: { available: true, snapshot }, stale: false, error: null }
  await render()
  expect(h.container.querySelector('[data-testid="onboarding-guide"]')).not.toBeNull()
  expect(h.container.querySelector('[data-refresh-failed]')).toBeNull()
  world.cloud = { state: 'value', value: { available: true, snapshot }, stale: false, error: new Error('manager unreachable') }
  await render()
  expect(h.container.querySelector('[data-testid="onboarding-guide"]')).not.toBeNull()
  ;(h.container.querySelector('[data-refresh-failed] button') as HTMLButtonElement).click()
  expect(world.refresh).toHaveBeenCalledOnce()
})
