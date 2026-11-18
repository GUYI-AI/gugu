import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome'
import { PhoneSessionSidebarControls } from '@/mobile/chat/PhoneSessionSidebarControls'
import { usePhoneSessionSidebar } from '@/mobile/chat/usePhoneSessionSidebar'
import { followRendererSession } from '@/lib/replica'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { installOwnedAgentEntry } from '@/lib/ownedAgentConversation'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { chat, device, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { normalCodexModelRows, normalCodexSelectedId } from './fixtures/phone-normal-model-catalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const host = vi.hoisted(() => ({ set: vi.fn(), normal: false, supported: true, fast: 'off', effort: 'medium' }))
vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => {
    const read = () => ({
      mode: null,
      model: host.normal
        ? { selected: normalCodexSelectedId, available: normalCodexModelRows.map(({ id, name, description }) => ({ id, name, description })) }
        : { selected: 'native-model', available: [{ id: 'native-model', name: 'Native Codex model' }] },
      effort: { selected: host.effort, available: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
      fast: host.supported ? { selected: host.fast, available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] } : null,
      modelMenu: { agentName: 'Codex', conversationSelection: null, platformModels: [], ownCatalog: null, ownAuth: null },
    })
    return { read: async () => read(), set: async (dimension: string, value: string) => {
      host.set(dimension, value)
      if (dimension === 'fast') host.fast = value
      if (dimension === 'effort') host.effort = value
      return read()
    } }
  },
}))
let harness: ReturnType<typeof createReactHarness> | undefined
let dispose: (() => void) | undefined
let bodyClass = ''
let bodyStyle: string | null = null
const Conversation = observer(() => {
  const sidebar = usePhoneSessionSidebar({ sessionId: 'room-task', entry: 'chat:room' })
  return <AgentWatchScreen title={host.normal ? '整理项目代码' : 'Fast 验收任务'} testId="fast-phone-work" bodyFill><SessionConversation
    timeline={emptyAgentWatchTimeline()} deviceId="qa-fast-device" sessionId="room-task" agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
    composerControls={sidebar.anchor ? (modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} /> : undefined}
  /></AgentWatchScreen>
})
async function mount(width = 390, theme: 'light' | 'dark' = 'dark') {
  followRendererSession('SIGNED_IN', 'owner')
  await page.viewport(width, 844)
  writeThemePreference(theme)
  document.documentElement.setAttribute('data-phone-shell', '')
  bodyClass = document.body.className
  bodyStyle = document.body.getAttribute('style')
  document.body.classList.add('bg-background', 'gugu-skin')
  document.body.classList.toggle('emdark', theme === 'dark')
  document.body.style.background = 'var(--background)'
  setLocalePreference('zh-CN')
  const chats = [chat({ id: 'room', kind: 'group', name: host.normal ? '开发讨论' : 'Fast 验收群' })]
  publishChatSummaries(chats)
  dispose = installOwnedAgentEntry({ open: () => false, owns: () => true })
  publishDirectoryDevices([device('qa-fast-device', [], { is_online: true, ...(host.normal ? { label: '隔离验收设备' } : {}) })])
  updateDeviceSessions('qa-fast-device', { projects: [{ id: 'workspace', name: 'Tasks', path: '', kind: 'workspace' }], sessions: [
    { conversationId: 'room-task', title: host.normal ? '整理项目代码' : 'Fast 验收任务', agent: { userId: 'room-agent' }, bornInChatId: 'room', projectId: 'workspace', harness: 'codex', runtime: 'acp', agentStatus: 'idle' } as SessionpageSessionSummary,
  ], cached: false, loading: false, error: null })
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', padding: '16px' })
  await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><Conversation /></SessionUiTheme></LocalizationProvider></ThemeProvider>,
    { auth: { id: 'owner' }, chat: { chats }, contacts: { contacts: [] } })
  await openWork()
}
async function openWork() {
  await page.getByTestId('agent-watch-create-model-device').click()
  await until('phone Work reads native thinking options', () => !!document.querySelector('[data-testid="agent-watch-create-controls-sheet"] [data-testid="phone-thinking-options"]'))
  await until('phone Work is fully visible', () => getComputedStyle(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!).opacity === '1')
  await Promise.all(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')!.getAnimations().map(animation => animation.finished))
  await document.fonts.ready
}
async function closeWork() {
  await page.getByTestId('agent-watch-create-controls-sheet-close').click()
  await until('existing Work actually closes', () => !document.querySelector('[data-testid="agent-watch-create-controls-sheet"]'))
}
afterEach(() => {
  harness?.cleanup(); dispose?.(); removeDeviceSessions('qa-fast-device'); publishDirectoryDevices([])
  document.documentElement.removeAttribute('data-phone-shell')
  document.documentElement.removeAttribute('data-theme')
  document.body.className = bodyClass
  if (bodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', bodyStyle)
  host.set.mockClear(); host.normal = false; host.supported = true; host.fast = 'off'; host.effort = 'medium'
})

// Keep the original controlled native-ID case and assertions; its placeholder
// captures remain internal. Normal captures use the same production metadata
// snapshot as B, without claiming a live CLI/account inventory.
const scenarios = [{ normal: false, width: 390, theme: 'dark' as const },
  ...[320, 390].flatMap(width => (['light', 'dark'] as const).map(theme => ({ normal: true, width, theme })))]
for (const { normal, width, theme } of scenarios) it(normal
  ? `${width}/${theme}: normal production catalog confirms text IDs, Fast returned values and close/reopen state`
  : 'the actual phone Work entry receives Fast and thinking settings, uses advertised text choices and sends real setting actions', async () => {
  host.normal = normal
  await mount(width, theme)
  const panel = page.getByTestId('agent-watch-create-controls-sheet')
  const capture = (name: string) => page.screenshot({ path: `__screenshots__/${normal ? 'owner-phone-regression' : 'internal-phone-model-pressure'}/${name}${normal ? `-${width}-${theme}` : ''}.png` })
  if (normal) {
    await until('production existing-page theme applied', () => document.documentElement.dataset.theme === theme)
    expect(document.body.textContent).toContain(normalCodexModelRows[0]!.name)
    expect(document.body.textContent).toContain('隔离验收设备')
    expect(document.body.textContent).not.toMatch(/Native Codex model|qa-fast-device|agentWatch\./)
    await page.elementLocator(document.querySelector<HTMLElement>('[data-dimension="effort"][data-testid="agent-watch-create-options-drill"]')!).click()
    const levels = Array.from(document.querySelectorAll('[data-testid="phone-thinking-options"] [role="radio"]'))
    expect(levels.map(level => level.getAttribute('data-option-id'))).toEqual(['low', 'medium', 'high'])
    expect(levels.map(level => level.querySelector('.gg-aw-choice-label')?.textContent)).toEqual(['低', '中', '高'])
    await page.getByTestId('agent-watch-create-controls-sheet-back').click()
  }
  const toggle = panel.getByRole('switch', { name: 'Fast', exact: true })
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  expect(document.querySelector('[data-testid="composer-model-trigger"]')).toBeNull()
  const button = document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"] [data-phone-fast]')!
  expect(document.querySelector('[data-testid="phone-thinking-options"] input[type="range"]')).toBeNull()
  const a = button.getBoundingClientRect()
  expect(a.height).toBe(44)
  expect(button.getAttribute('role')).toBe('switch')
  expect(button.getAttribute('aria-label')).toBe('Fast')
  await capture('G-existing-fast-off')
  await toggle.click()
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
  expect(host.set).toHaveBeenCalledWith('fast', 'on')
  await capture('G-existing-fast-on')
  await page.elementLocator(document.querySelector<HTMLElement>('[data-dimension="effort"][data-testid="agent-watch-create-options-drill"]')!).click()
  const high = document.querySelector<HTMLElement>('[data-testid="phone-thinking-options"] [data-option-id="high"]')!
  await page.elementLocator(high).click()
  await until('phone Work commits native effort', () => host.set.mock.calls.some(([dimension, value]) => dimension === 'effort' && value === 'high'))
  await page.elementLocator(document.querySelector<HTMLElement>('[data-dimension="effort"][data-testid="agent-watch-create-options-drill"]')!).click()
  await expect.element(page.elementLocator(document.querySelector<HTMLElement>('[data-testid="phone-thinking-options"] [data-option-id="high"]')!)).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('agent-watch-create-controls-sheet-back').click()
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
  expect(host.set.mock.calls.filter(([dimension]) => dimension === 'model')).toHaveLength(0)
  expect(document.querySelector('[data-slot="composer-toolbar"] [data-phone-fast]')).toBeNull()
  expect(document.body.textContent).not.toContain('更快，消耗更多额度')
  await capture('F-existing-thinking-high')
  if (normal) {
    await closeWork(); await openWork()
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await until('high returned value survives closing Work', () => document.querySelector('[data-dimension="effort"] .gg-phone-composer-summary-value')?.textContent === '高')
  }
  await toggle.click()
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  expect(host.set).toHaveBeenCalledWith('fast', 'off')
  if (normal) {
    await closeWork(); await openWork()
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await until('high and OFF returned values survive reopening Work', () => document.querySelector('[data-dimension="effort"] .gg-phone-composer-summary-value')?.textContent === '高')
    await capture('G-existing-fast-off-again')
    expect(host.set.mock.calls).toEqual([['fast', 'on'], ['effort', 'high'], ['fast', 'off']])
    await page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
    await until('normal raw CLI selection survives thinking and Fast updates', () => document.querySelector(`[data-dimension="model"][data-option-id="${normalCodexSelectedId}"]`)?.getAttribute('aria-checked') === 'true')
    const selected = document.querySelector<HTMLElement>(`[data-dimension="model"][data-option-id="${normalCodexSelectedId}"]`)!
    await expect.element(page.elementLocator(selected)).toHaveAttribute('aria-checked', 'true')
    expect(host.set.mock.calls.filter(([dimension]) => dimension === 'model')).toHaveLength(0)
  }
})

it('the same phone Work entry retains thinking but hides Fast when the host advertises no eligible capability', async () => {
  host.supported = false
  await mount()
  expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"] [data-phone-fast]')).toBeNull()
  await page.elementLocator(document.querySelector<HTMLElement>('[data-dimension="effort"][data-testid="agent-watch-create-options-drill"]')!).click()
  expect(document.querySelectorAll('[data-testid="phone-thinking-options"] [role="radio"]')).toHaveLength(3)
  expect(host.set).not.toHaveBeenCalled()
})

it('normal production catalog: existing Work without Fast retains text IDs across close/reopen', async () => {
  host.normal = true; host.supported = false
  await mount(390, 'dark')
  const assertUnavailable = async () => {
    expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"] [data-phone-fast]')).toBeNull()
    expect(document.body.textContent).toContain(normalCodexModelRows[0]!.name)
    expect(document.body.textContent).toContain('隔离验收设备')
    expect(document.body.textContent).not.toMatch(/Native Codex model|qa-fast-device|agentWatch\./)
    await page.elementLocator(document.querySelector<HTMLElement>('[data-dimension="effort"][data-testid="agent-watch-create-options-drill"]')!).click()
    const choices = Array.from(document.querySelectorAll('[data-testid="phone-thinking-options"] [role="radio"]'))
    expect(choices.map(choice => choice.getAttribute('data-option-id'))).toEqual(['low', 'medium', 'high'])
    expect(choices.find(choice => choice.getAttribute('data-option-id') === 'medium')?.getAttribute('aria-checked')).toBe('true')
    expect(host.set).not.toHaveBeenCalled()
    await page.getByTestId('agent-watch-create-controls-sheet-back').click()
  }
  await assertUnavailable()
  await closeWork(); await openWork(); await assertUnavailable()
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/G-existing-fast-unavailable-390-dark.png' })
})
