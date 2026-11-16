import { act, useEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { AgentWatchPage } from '@/mobile/agent-watch/AgentWatchPage'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { chat, device, displayIdentity, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// This is I-existing-task evidence. The full production page, sidebar scope,
// picker, portal and emitted destination stay real. Only the external directory,
// platform and MainLayout's outer event-consumer boundary are controlled.
// Directory reachability is controlled independently from the unavailable host
// transport. Offline computers ignore the live directory and their digest omits
// bornInChatId, so an offline fixture cannot prove a source-room anchor.
// This does not prove MainLayout, a real host, or creation/first-message delivery.
vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
// Only the host-history transport result is controlled; keep the full page,
// sidebar scope and picker. Lost transport prevents native/model/window reads.
vi.mock('@/mobile/agent-watch/useAgentWatchSession', async original => {
  const { emptyAgentWatchTimeline } = await import('@/mobile/agent-watch/agent-watch-store')
  const timeline = emptyAgentWatchTimeline()
  return { ...await original<object>(), useAgentWatchSession: () => ({
    timeline, phase: 'ready', error: null, actionError: null, dismissActionError() {}, waitingForRecord: false, reload() {},
    loadOlder: async () => undefined, loadToolImage: async () => undefined, pendingSends: [], respond: async () => ({ ok: true }),
    sending: false, respondingItemId: null, cancel() {}, cancelling: false, link: 'lost', errorCode: null,
  }) }
})
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

const roomId = 'I-existing-room'
const machine = device('I-controlled-device', [], { is_online: true, status: 'online' })
const sessions: SessionpageSessionSummary[] = Array.from({ length: 35 }, (_, n) => ({
  conversationId: `I-session-${n}`, title: `Session ${n}`, projectId: 'workspace', harness: 'codex',
  runtime: 'acp', supported: true, agentStatus: 'idle', bornInChatId: roomId,
  agent: { userId: `I-agent-${n}` },
} as SessionpageSessionSummary))
const identities = Object.fromEntries(sessions.map((session, n) => [session.agent!.userId, displayIdentity(session.agent!.userId, {
  type: 'agent', owner_user_id: 'I-owner', display_name: n < 2 ? '同名智能体' : `其它智能体 ${n}`, avatar: null,
})]))
const devices: DevicesContextValue = { devices: [machine], loading: false, error: null,
  refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] }
type Destination = { deviceId: string; session: SessionpageSessionSummary; innerSidebarEntry?: string }
async function openActualAgentPicker() {
  const toggle = page.getByTestId('phone-composer-menu-toggle')
  const button = document.querySelector<HTMLButtonElement>('[data-testid="phone-composer-menu-toggle"]')!
  if (button.getAttribute('aria-expanded') === 'false') await toggle.click()
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('phone-room-agents').click()
}
const destinations: Destination[] = []
let harness: ReturnType<typeof createReactHarness> | undefined

function ControlledOuterBoundary() {
  const [destination, setDestination] = useState<Destination | null>(null)
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Destination>).detail
      destinations.push(next)
      setDestination(next)
    }
    window.addEventListener(APP_SHOW_SESSION_EVENT, receive)
    return () => window.removeEventListener(APP_SHOW_SESSION_EVENT, receive)
  }, [])
  return <AgentWatchPage active onExit={() => {}} openRequest={destination} />
}

afterEach(() => {
  harness?.cleanup(); harness = undefined
  removeDeviceSessions(machine.device_id); publishDirectoryDevices([]); publishIdentityDirectory(null, null)
  publishChatSummaries([]); destinations.length = 0
  document.documentElement.removeAttribute('data-phone-shell')
  document.documentElement.removeAttribute('data-theme')
})

for (const width of [320, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: actual existing-task sidebar keeps Agent search first and routes duplicate names by ID (controlled directory/lost transport)`, async () => {
    await page.viewport(width, 844); setLocalePreference('zh-CN')
    writeThemePreference(theme)
    document.documentElement.setAttribute('data-phone-shell', '')
    installIdentityDirectoryBridge(); publishIdentityDirectory(identities, null)
    const room = chat({ id: roomId, kind: 'group', name: '受控来源群' })
    publishChatSummaries([room])
    publishDirectoryDevices([machine])
    updateDeviceSessions(machine.device_id, { projects: [], sessions, cached: false, loading: false, error: null })
    harness = createReactHarness()
    harness.container.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column'
    await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><DevicesContext.Provider value={devices}>
      <PhoneViewportShell mobile data-phone-shell="" data-ta-scope="" className="h-full flex flex-col" style={{ background: 'var(--ta-panel-bg)' }}><ControlledOuterBoundary /></PhoneViewportShell>
    </DevicesContext.Provider></SessionUiTheme></LocalizationProvider></ThemeProvider>,
    { auth: { id: 'I-owner' }, chat: { chats: [room], identitiesById: identities } })
    await act(async () => {
      window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, {
        detail: { deviceId: machine.device_id, session: sessions[0]!, innerSidebarEntry: `chat:${roomId}` },
      }))
    })
    const header = () => harness!.container.querySelector<HTMLElement>('[data-testid="agent-watch-hero"]')
    await until('real existing task A with its source-room sidebar', () => header()?.dataset.sessionId === 'I-session-0'
      && !!harness?.container.querySelector('[data-testid="phone-session-sidebar-controls"][data-anchor-chat="I-existing-room"]'))
    await openActualAgentPicker()
    const panel = () => document.querySelector<HTMLElement>('[data-testid="phone-room-controls-sheet"]')!
    const list = () => panel().querySelector<HTMLElement>('.gg-phone-composer-sheet-list')!
    const search = () => panel().querySelector<HTMLElement>('.gg-phone-navigation-search')!
    await until('real catalog rows in the actual sidebar', () => panel()?.querySelectorAll('[data-testid="phone-sidebar-agent"]').length === 35)
    expect(list().firstElementChild?.firstElementChild).toBe(search())
    expect(getComputedStyle(search()).position).toBe('sticky')
    await expect.element(page.getByTestId('phone-agents-search')).toHaveAttribute('placeholder', '搜索智能体')
    expect(header()?.textContent).toContain('同名智能体')
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(document.body.textContent).not.toMatch(/agentWatch\.|shell\./)
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/I-existing-sidebar-open-controlled-${width}-${theme}.png` })
    list().scrollTop = 400
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(list().scrollTop).toBeGreaterThan(0)
    expect(search().getBoundingClientRect().top).toBeGreaterThanOrEqual(list().getBoundingClientRect().top - 1)
    expect(search().getBoundingClientRect().top).toBeLessThanOrEqual(list().getBoundingClientRect().top + 12)
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/I-existing-sidebar-scroll-controlled-${width}-${theme}.png` })
    await page.getByTestId('phone-agents-search').fill('同名')
    await until('duplicate names remain distinct catalog entries', () => panel().querySelectorAll('[data-testid="phone-sidebar-agent"]').length === 2)
    expect(panel().querySelector('[data-session-id="I-session-0"]')).not.toBeNull()
    expect(panel().querySelector('[data-session-id="I-session-1"]')).not.toBeNull()
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/I-existing-sidebar-search-controlled-${width}-${theme}.png` })
    await page.elementLocator(panel().querySelector<HTMLElement>('[data-session-id="I-session-1"]')!).click()
    await until('actual page consumes the emitted B destination', () => header()?.dataset.sessionId === 'I-session-1'
      && header()?.dataset.agentId === 'I-agent-1')
    expect(destinations.at(-1)).toMatchObject({ deviceId: machine.device_id,
      session: { conversationId: 'I-session-1' }, innerSidebarEntry: `chat:${roomId}` })
    await until('chosen row closes the actual panel', () => !document.querySelector('[data-testid="phone-room-controls-sheet"]'))
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/I-existing-sidebar-picked-b-controlled-${width}-${theme}.png` })
    await openActualAgentPicker()
    expect((document.querySelector('[data-testid="phone-agents-search"]') as HTMLInputElement).value).toBe('')
  })
}
