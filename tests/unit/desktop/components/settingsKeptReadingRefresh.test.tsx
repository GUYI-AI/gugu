// @vitest-environment jsdom
// Settings rows drawn from a reading read before whose read again failed: the value stays, the failure is said
// (RefreshFailed) — ❌ drawn as current. 通用 (notifications, tray badge) and 快速聊天.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const kept = <V,>(value: V) => ({ state: 'value', value, stale: true, error: new Error('main unreachable') })
const io = vi.hoisted(() => ({ notifications: null as unknown, tray: null as unknown, quick: null as unknown, refreshQuick: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({ setNotificationSettings: vi.fn(), useNotificationSettingsReading: () => io.notifications }))
vi.mock('../../../../apps/desktop/src/lib/trayBadgeSetting', () => ({ setTrayBadgeEnabled: vi.fn(), useTrayBadgeEnabled: () => io.tray }))
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

const { GeneralSection } = await import('../../../../apps/desktop/src/components/settings/GeneralSection')
const { QuickChatSettingsGroup } = await import('../../../../apps/desktop/src/components/assistant/ComputerHomeSettings')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const failed = () => harness.container.querySelectorAll('[data-refresh-failed]')

describe('a setting read before whose read again failed', () => {
  it('通用: the notification and tray badge toggles stay drawn, each group says its failure', async () => {
    io.notifications = kept({ chatMessages: true, sound: false })
    io.tray = kept(true)
    await renderWithAppProviders(harness, createElement(GeneralSection, { onOpenPermissions: () => undefined }))
    expect(harness.container.querySelectorAll('[role="switch"], input[type="checkbox"]').length).toBeGreaterThanOrEqual(3)
    expect(failed()).toHaveLength(2)
  })

  it('通用: read and current, nothing is said', async () => {
    io.notifications = { state: 'value', value: { chatMessages: true, sound: false }, stale: false, error: null }
    io.tray = { state: 'value', value: true, stale: false, error: null }
    await renderWithAppProviders(harness, createElement(GeneralSection, { onOpenPermissions: () => undefined }))
    expect(failed()).toHaveLength(0)
  })

  it('快速聊天: the switch stays, the failure is said with a retry', async () => {
    io.quick = kept({ supported: true, enabled: true, registered: true, accelerator: 'Alt+Space' })
    await renderWithAppProviders(harness, createElement(QuickChatSettingsGroup, { assistantName: '小咕' }))
    expect(harness.container.querySelector('[data-testid="assistant-settings-quick-chat"]')).not.toBeNull()
    expect(failed()).toHaveLength(1)
    ;(failed()[0]!.querySelector('button') as HTMLButtonElement).click()
    expect(io.refreshQuick).toHaveBeenCalled()
  })
})
