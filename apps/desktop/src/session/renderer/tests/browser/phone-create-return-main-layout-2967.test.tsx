import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateRequest, SessionpageSessionCreateResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { MainLayout } from '@/layouts/MainLayout'
import { ThemeProvider } from '@/store/theme'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import { NATIVE_BACK_EVENT } from '@/components/ui/sheetStack'
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { createReactHarness, renderWithAppProviders, device, displayIdentity } from '../../../../../../../tests/support/testHarness'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// MainLayout, AgentWatchPage, CreateSessionPage, their headers and route callbacks
// are real. Only account/directory/preferences/host transport readings are controlled.
// Partners has no direct New Agent button: its project destination below comes
// through the real App protocol, then the actual Projects + button. It is not
// evidence of a nonexistent direct creation action on the Partners root.
const fixture = vi.hoisted(() => ({
  owner: 'return-route-owner', devices: [] as Device[], directory: {} as Record<string, DeviceSessions>,
  create: vi.fn<(deviceId: string, request: SessionpageSessionCreateRequest) => Promise<SessionpageSessionCreateResult>>(),
}))
vi.mock('@/platform', async () => {
  const { createCapacitorPlatformTestDouble } = await import('../../../../../../../tests/support/platformTestDoubles')
  const platform = createCapacitorPlatformTestDouble()
  // A renderer-only phone shell, with a remote computer target; never start a native phone host.
  platform.capabilities.phoneDevice = false
  // The full shell imports SettingsPanel, which reads the platform permission
  // inventory during module evaluation. This isolated web fixture exposes none.
  return { platform: { ...platform, systemPermissions: [] } }
})
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'))
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'))
vi.mock('@/mobile/assistant/usePhoneAssistant', () => ({ usePhoneAssistant: () => ({ available: false, chatId: null }) }))
vi.mock('@/mobile/agent-watch/useAgentWatchAlerts', async original => ({ ...await original<typeof import('@/mobile/agent-watch/useAgentWatchAlerts')>(),
  // Background directory/notification transports are outside this renderer route contract.
  useAgentWatchAlerts: () => {}, useAgentWatchFocus: () => {}, requestAlertPermissionOnce: () => {},
}))
vi.mock('@/components/needsYou/useNeedsYouTasks', async original => ({ ...await original<object>(), useNeedsYouTasks: () => ({ tasks: [], count: 0, attention: null, error: null }) }))
vi.mock('@/lib/passwordBetaNotifications', async original => ({ ...await original<object>(), usePasswordNotifications: () => [], usePasswordSnapshot: () => null }))
vi.mock('@/store/devicesContext', async original => ({ ...await original<typeof import('@/store/devicesContext')>(),
  useDevicesStore: () => ({ devices: fixture.devices, phones: [], loading: false, error: null,
    refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] }),
}))
vi.mock('@/session/shared/remote-sessions/session-directory', async original => ({ ...await original<typeof import('@/session/shared/remote-sessions/session-directory')>(),
  useLiveDeviceSessions: () => fixture.directory,
}))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => '隔离验收电脑', isHome: () => false }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ rememberRunMachine: vi.fn(),
  useProjectRunMachine: () => ({ machine: fixture.devices[0]?.device_id ?? null, pick: vi.fn() }),
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...await original<typeof import('@/mobile/agent-watch/sessionpage-rpc')>(),
  fetchCreateOptions: async () => ({ projects: [], lastUsed: { harness: 'codex', model: 'native-model', permissionMode: null, effort: null },
    harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
  fetchCreateModels: async () => ({ harness: 'codex', transport: 'acp', selected: 'native-model', selectedEffort: null, efforts: [],
    harnessState: 'ready', harnessAuth: 'signed-in', selectedCredential: 'credentialed', models: [{ id: 'native-model', name: 'Native model', source: 'harness' }] }),
  createSession: fixture.create,
  machineRpc: () => ({ sessionTimeline: { sessionCreateSkills: async () => ({ ok: true, value: { skills: [] } }) } }),
}))

let harness: ReturnType<typeof createReactHarness> | undefined
let sequence = 0
beforeEach(() => {
  fixture.owner = `return-route-owner-${++sequence}`
  fixture.devices = [device('return-device', [], { label: '隔离验收电脑', is_online: true, status: 'online' })]
  fixture.directory = { 'return-device': { projects: [{ id: 'workspace', name: '验收项目', path: '', kind: 'workspace' }], sessions: [], cached: false, loading: false, error: null } }
  accountProjectsStore.clear()
  fixture.create.mockReset().mockImplementation(async (deviceId, request) => {
    expect(deviceId).toBe('return-device')
    expect(request.prompt).toBe('只核对返回路线')
    const session: SessionpageSessionSummary = { conversationId: 'created-return-session', title: '返回路线验收', projectId: 'workspace', harness: 'codex', runtime: 'acp',
      supported: true, agentStatus: 'idle', lastInteractedAt: null, agent: { userId: 'created-return-agent' } }
    // The controlled receipt changes directory presence to offline before showing
    // the real timeline, so this fixture cannot issue a real host/model request.
    fixture.devices[0]!.is_online = false
    fixture.devices[0]!.status = 'offline'
    fixture.directory['return-device'] = { ...fixture.directory['return-device']!, sessions: [session] }
    return { conversationId: session.conversationId, projectId: session.projectId, title: session.title, session }
  })
})
afterEach(() => {
  harness?.cleanup(); harness = undefined
  composerDrafts.discard(mobileCreationDraftKey(fixture.owner))
  accountProjectsStore.clear(); publishIdentityDirectory(null, null)
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-phone-root')
})

type Entry = 'messages' | 'partners-project-protocol'
const shown = (testId: string) => harness!.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const layerOpen = () => shown('mobile-sessions-layer')?.hasAttribute('data-open') === true
async function systemBack() { await act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT)) }) }
async function screenshot(entry: Entry, theme: 'light' | 'dark', phase: string) {
  // navigateMobile commits the route before its old/new picture transition ends.
  // Its real finished handler clears this marker; never skip the animation to capture.
  await until('the real mobile page transition has finished before capture', () => document.documentElement.dataset.mobileDirection === undefined)
  const atOrigin = ['before', 'returned-origin', 'cancel-origin', 'consecutive-back'].includes(phase)
  const nav = () => harness!.container.querySelector<HTMLElement>('[data-phone-tabbar]')
  if (atOrigin) await until('the returned shell has its real bottom navigation', () => !!nav()?.getBoundingClientRect().height)
  await untilStable('the real shell page and bottom navigation geometry have settled', () => (
    [...harness!.container.querySelectorAll<HTMLElement>('[data-mobile-tab-page], [data-phone-tabbar], [data-testid="mobile-sessions-layer"]')].map(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { tab: element.dataset.mobileTabPage, open: element.dataset.open, inert: element.inert,
        rect: [box.left, box.top, box.width, box.height], opacity: style.opacity, transform: style.transform }
    })
  ))
  expect(document.documentElement.dataset.mobileDirection).toBeUndefined()
  if (atOrigin) {
    const selected = entry === 'messages' ? AUTOMATION_TEST_IDS.mobileMessagesNav : AUTOMATION_TEST_IDS.mobileContactsNav
    expect(nav()!.querySelector(`[data-testid="${selected}"]`)?.getAttribute('aria-current')).toBe('page')
    await expectOrigin(entry)
  }
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/M-${entry}-${theme}-${phase}.png` })
}
async function mount(theme: 'light' | 'dark') {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); writeThemePreference(theme)
  installIdentityDirectoryBridge()
  publishIdentityDirectory({ 'created-return-agent': displayIdentity('created-return-agent', { type: 'agent', owner_user_id: fixture.owner, display_name: '返回路线验收', avatar: null }) }, null)
  harness = createReactHarness(); Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex' })
  const user = { id: fixture.owner, email: 'fixture@example.invalid', nickname: '返回验收' }
  await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}>
    <MessageProvider locale="zh-CN" translate={translateSessionMessage}><MainLayout user={user} effectsActive={false} /></MessageProvider>
  </SessionUiTheme></LocalizationProvider></ThemeProvider>, { auth: user, chat: { chats: [], activeChatId: null } })
  await until('real Messages creation action', () => !!shown(AUTOMATION_TEST_IDS.mobileSessionCreateAction)?.getBoundingClientRect().width)
}
async function enter(entry: Entry) {
  fixture.devices[0]!.is_online = true; fixture.devices[0]!.status = 'online'
  if (entry === 'messages') await page.getByTestId(AUTOMATION_TEST_IDS.mobileSessionCreateAction).click()
  else {
    // Existing external project route used by App/links. MainLayout consumes it;
    // the fixture never calls setActiveTab, setRoute or a creation callback.
    await act(async () => { window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { projectId: 'workspace' } })) })
    await until('real visited Projects route', () => layerOpen() && !!shown('agent-watch-create-session')?.getBoundingClientRect().width)
    await page.getByTestId('agent-watch-create-session').click()
  }
  await until('real creation form', () => layerOpen() && !!shown('agent-watch-create-page')?.querySelector('[contenteditable]'))
  expect(shown('agent-watch-create-page')!.querySelector('[contenteditable]')?.getAttribute('aria-label')).toBe('第一句话…')
  expect(shown('agent-watch-create-page')!.textContent).not.toContain('agentWatch.')
}
async function submit() {
  const input = shown('agent-watch-create-page')!.querySelector<HTMLElement>('[contenteditable]')!
  await page.elementLocator(input).fill('只核对返回路线')
  await until('real creation submit enabled', () => shown('agent-watch-create-page')?.querySelector<HTMLButtonElement>('[data-phone-send]')?.disabled === false)
  await page.elementLocator(shown('agent-watch-create-page')!.querySelector<HTMLElement>('[data-phone-send]')!).click()
  await until('real created Agent route with receipt IDs', () => shown('agent-watch-hero')?.dataset.sessionId === 'created-return-session')
  expect(fixture.create).toHaveBeenCalledTimes(1)
  expect(shown('agent-watch-hero')?.dataset.agentId).toBe('created-return-agent')
  expect(shown('agent-watch-hero')?.textContent).toContain('返回路线验收')
  expect(shown('agent-watch-create-page')).toBeNull()
}
async function expectOrigin(entry: Entry) {
  await until('the actual shell origin is shown', () => !layerOpen() && harness!.container.querySelector(`[data-mobile-tab-page="${entry === 'messages' ? 'chats' : 'contacts'}"]`)?.hasAttribute('inert') === false)
  if (entry === 'messages') expect(shown(AUTOMATION_TEST_IDS.mobileSessionCreateAction)!.getBoundingClientRect().width).toBeGreaterThan(0)
  else expect(harness!.container.querySelector('.gg-partners')!.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(shown('mobile-sessions-layer')?.hasAttribute('inert')).toBe(true)
}

for (const theme of ['light', 'dark'] as const) for (const entry of ['messages', 'partners-project-protocol'] as const) {
  it(`${entry}/${theme}: actual shell creation replaces the form and returns through only visited routes`, async () => {
    await mount(theme)
    if (entry !== 'messages') await page.getByTestId(AUTOMATION_TEST_IDS.mobileContactsNav).click()
    await expectOrigin(entry); await screenshot(entry, theme, 'before')
    await enter(entry); await screenshot(entry, theme, 'create-form')
    await submit(); await screenshot(entry, theme, 'created-offline-receipt')
    const back = shown('agent-watch-hero')!.querySelector<HTMLButtonElement>('button[aria-label="返回"]')!
    expect(back).not.toBeNull(); await page.elementLocator(back).click()
    if (entry !== 'messages') {
      await until('Back reaches the actually visited Projects page', () => layerOpen() && !!shown('agent-watch-create-session')?.getBoundingClientRect().width)
      expect(shown('agent-watch-create-page')).toBeNull()
      await screenshot(entry, theme, 'visited-projects-back')
      await systemBack()
    }
    await expectOrigin(entry); await screenshot(entry, theme, 'returned-origin')
    await enter(entry)
    await systemBack()
    if (entry !== 'messages') {
      await until('cancel reaches the visited Projects page', () => layerOpen() && !!shown('agent-watch-create-session')?.getBoundingClientRect().width)
      await screenshot(entry, theme, 'cancel-visited-projects')
      await systemBack()
    }
    await expectOrigin(entry); await screenshot(entry, theme, 'cancel-origin')
    expect(fixture.create).toHaveBeenCalledTimes(1)
    await systemBack()
    expect(layerOpen(), 'another root Back never resurrects Create or a synthetic Projects layer').toBe(false)
    await screenshot(entry, theme, 'consecutive-back')
  })
}
