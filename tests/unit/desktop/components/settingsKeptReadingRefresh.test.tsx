// @vitest-environment jsdom
// Settings rows drawn from a reading read before whose read again failed: the value stays, the failure is said
// (RefreshFailed, with the reading's own retry) — ❌ drawn as current. 快速聊天.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const kept = <V,>(value: V) => ({ state: 'value', value, stale: true, error: new Error('main unreachable') })
const io = vi.hoisted(() => ({ quick: null as unknown, refreshQuick: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/systemPermissions', () => ({ useSystemPermissionStates: () => ({ states: {}, refresh: async () => undefined }) }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: new Proxy(actual.platform, {
    get: (target, key) => (key === 'capabilities' ? { ...target.capabilities, badge: true, agentRuntime: false } : key === 'kind' ? 'electron' : Reflect.get(target, key)),
  }) }
})
vi.mock('../../../../apps/desktop/src/components/HelpImprove', () => ({ HelpImproveSettingGroup: () => null }))
vi.mock('../../../../apps/desktop/src/components/assistant/useQuickChatState', () => ({
  quickChatShortcutLabel: () => '⌥Space',
  quickChatState: { refresh: io.refreshQuick },
  useQuickChatState: () => ({ available: true, reading: io.quick, setEnabled: vi.fn() }),
}))

const { QuickChatSettingsGroup } = await import('../../../../apps/desktop/src/components/assistant/ComputerHomeSettings')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const failed = () => harness.container.querySelectorAll('[data-refresh-failed]')

describe('a setting read before whose read again failed', () => {
  it('快速聊天: the switch stays, the failure is said with a retry', async () => {
    io.quick = { ...kept({ supported: true, enabled: true, registered: true, accelerator: 'Alt+Space' }), retry: io.refreshQuick }
    await renderWithAppProviders(harness, createElement(QuickChatSettingsGroup, { assistantName: '小咕' }))
    expect(harness.container.querySelector('[data-testid="assistant-settings-quick-chat"]')).not.toBeNull()
    expect(failed()).toHaveLength(1)
    ;(failed()[0]!.querySelector('button') as HTMLButtonElement).click()
    expect(io.refreshQuick).toHaveBeenCalled()
  })
})
