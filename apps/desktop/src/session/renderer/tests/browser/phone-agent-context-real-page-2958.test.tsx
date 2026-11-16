import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { AgentWatchPage } from '@/mobile/agent-watch/AgentWatchPage'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { device, displayIdentity, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// An offline controlled directory deliberately starts no host/model request.
// AgentWatchPage and SessionTimelinePage, their route state and header stay real.
vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
const machine = device('context-device', [], { is_online: false, status: 'offline' })
const sessions = ['a', 'b'].map(id => ({ conversationId: `session-${id}`, title: `Session ${id}`, projectId: 'workspace', harness: 'codex',
  runtime: 'acp', supported: true, agentStatus: 'idle', agent: { userId: `agent-${id}` } } as SessionpageSessionSummary))
const devices: DevicesContextValue = { devices: [machine], loading: false, error: null,
  refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] }
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => {
  harness?.cleanup(); removeDeviceSessions(machine.device_id); publishDirectoryDevices([]); publishIdentityDirectory(null, null)
  document.documentElement.removeAttribute('data-phone-shell'); delete document.documentElement.dataset.theme
})

for (const width of [360, 390]) for (const theme of ['light', 'dark']) {
  it(`${width}/${theme}: actual Agent route and identity follow distinct IDs and a live rename`, async () => {
    await page.viewport(width, 844); setLocalePreference('zh-CN')
    writeThemePreference(theme); document.documentElement.setAttribute('data-phone-shell', '')
    installIdentityDirectoryBridge()
    const identities = Object.fromEntries(['a', 'b'].map(id => [`agent-${id}`, displayIdentity(`agent-${id}`, {
      type: 'agent', owner_user_id: 'owner', display_name: '同名智能体', avatar: null,
    })]))
    publishIdentityDirectory(identities, null)
    publishDirectoryDevices([machine]); updateDeviceSessions(machine.device_id, { projects: [], sessions, cached: false, loading: false, error: null })
    harness = createReactHarness(); Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
    const exit = vi.fn()
    const draw = (session: SessionpageSessionSummary | null) => renderWithAppProviders(harness!, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><DevicesContext.Provider value={devices}>
      <PhoneViewportShell mobile data-phone-shell="" data-ta-scope="" className="h-full flex flex-col bg-background">
        <AgentWatchPage active onExit={exit} openRequest={session ? { deviceId: machine.device_id, session } : null} />
      </PhoneViewportShell>
    </DevicesContext.Provider></SessionUiTheme></LocalizationProvider></ThemeProvider>, { auth: { id: 'owner' }, chat: { identitiesById: identities } })
    await draw(null)
    const header = () => harness!.container.querySelector<HTMLElement>('[data-testid="agent-watch-hero"]')
    await draw(sessions[0]!)
    await until('actual Agent A route', () => header()?.dataset.sessionId === 'session-a' && header()?.dataset.agentId === 'agent-a')
    expect(header()?.textContent).toContain('同名智能体')
    expect(harness!.container.textContent).not.toMatch(/agentWatch\.|shell\./)
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/K-agent-a-offline-${width}-${theme}.png` })
    await draw(sessions[1]!)
    await until('actual Agent B route', () => header()?.dataset.sessionId === 'session-b' && header()?.dataset.agentId === 'agent-b')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/K-agent-b-offline-${width}-${theme}.png` })
    await act(async () => publishIdentityDirectory({ ...identities, 'agent-b': { ...identities['agent-b']!, display_name: '改名后的智能体 B' } }, null))
    await until('current identity rename', () => header()?.textContent?.includes('改名后的智能体 B') === true)
    expect(header()?.dataset.sessionId).toBe('session-b')
    expect(header()?.dataset.agentId).toBe('agent-b')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/K-agent-b-renamed-offline-${width}-${theme}.png` })
    await page.elementLocator(header()!.querySelector<HTMLButtonElement>('button')!).click()
    expect(exit).toHaveBeenCalledExactlyOnceWith()
  })
}
