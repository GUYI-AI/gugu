import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome'
import { PhoneSessionSidebarControls } from '@/mobile/chat/PhoneSessionSidebarControls'
import { usePhoneSessionSidebar } from '@/mobile/chat/usePhoneSessionSidebar'
import { followRendererSession } from '@/lib/replica'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { installOwnedAgentEntry } from '@/lib/ownedAgentConversation'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { chat, device, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
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

const host = vi.hoisted(() => ({ set: vi.fn(), supported: true, fast: 'off', effort: 'medium' }))
vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => {
    const read = () => ({
      mode: null,
      model: { selected: 'native-model', available: [{ id: 'native-model', name: 'Native Codex model' }] },
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
  return <AgentWatchScreen title="Fast 验收任务" testId="fast-phone-work" bodyFill><SessionConversation
    timeline={emptyAgentWatchTimeline()} deviceId="qa-fast-device" sessionId="room-task" agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
    composerControls={sidebar.anchor ? (modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} /> : undefined}
  /></AgentWatchScreen>
})
async function mount() {
  followRendererSession('SIGNED_IN', 'owner')
  await page.viewport(390, 844)
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.setAttribute('data-phone-shell', '')
  bodyClass = document.body.className
  bodyStyle = document.body.getAttribute('style')
  document.body.classList.add('bg-background', 'gugu-skin', 'emdark')
  document.body.style.background = 'var(--background)'
  setLocalePreference('zh-CN')
  const chats = [chat({ id: 'room', kind: 'group', name: 'Fast 验收群' })]
  publishChatSummaries(chats)
  dispose = installOwnedAgentEntry({ open: () => false, owns: () => true })
  publishDirectoryDevices([device('qa-fast-device', [], { is_online: true })])
  updateDeviceSessions('qa-fast-device', { projects: [{ id: 'workspace', name: 'Tasks', path: '', kind: 'workspace' }], sessions: [
    { conversationId: 'room-task', title: 'Fast 验收任务', agent: { userId: 'room-agent' }, bornInChatId: 'room', projectId: 'workspace', harness: 'codex', runtime: 'acp', agentStatus: 'idle' } as SessionpageSessionSummary,
  ], cached: false, loading: false, error: null })
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', padding: '16px' })
  await renderWithAppProviders(harness, <LocalizationProvider><SessionUiTheme theme="dark"><Conversation /></SessionUiTheme></LocalizationProvider>,
    { auth: { id: 'owner' }, chat: { chats }, contacts: { contacts: [] } })
  await page.getByTestId('agent-watch-create-model-device').click()
  await until('phone Work reads native thinking options', () => !!document.querySelector('[data-testid="agent-watch-create-controls-sheet"] [data-slot="composer-effort-row"]'))
  await until('phone Work is fully visible', () => getComputedStyle(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!).opacity === '1')
  await Promise.all(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')!.getAnimations().map(animation => animation.finished))
  await document.fonts.ready
}
afterEach(() => {
  harness?.cleanup(); dispose?.(); removeDeviceSessions('qa-fast-device'); publishDirectoryDevices([])
  document.documentElement.removeAttribute('data-phone-shell')
  document.body.className = bodyClass
  if (bodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', bodyStyle)
  host.set.mockClear(); host.supported = true; host.fast = 'off'; host.effort = 'medium'
})

it('the actual phone Work entry receives Fast and thinking settings, uses the shared axis and sends real setting actions', async () => {
  await mount()
  const panel = page.getByTestId('agent-watch-create-controls-sheet')
  const toggle = panel.getByRole('button', { name: '快速', exact: true })
  await expect.element(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(document.querySelector('[data-testid="composer-model-trigger"]')).toBeNull()
  const button = document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"] [data-fast-mode-toggle]')!
  const track = document.querySelector<HTMLElement>('[data-slot="composer-effort-indicator"]')!.parentElement!
  const a = button.getBoundingClientRect(), b = track.getBoundingClientRect()
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(1)
  expect(Math.abs(a.x - b.right - 8)).toBeLessThan(0.5)
  expect(a.height).toBe(44)
  expect(button.firstElementChild!.getBoundingClientRect().height).toBe(32)
  expect(getComputedStyle(button.firstElementChild!).fontSize).toBe('13px')
  expect(button.querySelector('svg')!.getBoundingClientRect().width).toBe(14)
  await page.screenshot({ path: '__screenshots__/phone-work-fast-off.png' })
  await toggle.click()
  await expect.element(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(host.set).toHaveBeenCalledWith('fast', 'on')
  await page.screenshot({ path: '__screenshots__/phone-work-fast-on.png' })
  const range = document.querySelector<HTMLInputElement>('[data-slot="composer-effort-row"] input[type="range"]')!
  range.focus()
  await userEvent.keyboard('{ArrowRight}')
  await until('phone Work commits native effort', () => host.set.mock.calls.some(([dimension, value]) => dimension === 'effort' && value === 'high'))
  await expect.element(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(host.set.mock.calls.filter(([dimension]) => dimension === 'model')).toHaveLength(0)
  expect(document.querySelector('[data-slot="composer-toolbar"] [data-fast-mode-toggle]')).toBeNull()
  expect(document.body.textContent).not.toContain('更快，消耗更多额度')
})

it('the same phone Work entry retains thinking but hides Fast when the host advertises no eligible capability', async () => {
  host.supported = false
  await mount()
  expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"] [data-fast-mode-toggle]')).toBeNull()
  expect(document.querySelector('[data-slot="composer-effort-indicator"]')).not.toBeNull()
  expect(host.set).not.toHaveBeenCalled()
})
