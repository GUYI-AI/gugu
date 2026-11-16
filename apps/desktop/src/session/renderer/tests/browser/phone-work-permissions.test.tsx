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

const host = vi.hoisted(() => ({ set: vi.fn(), supported: true, selected: ':danger-full-access', fail: false, review: false }))
vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => {
    const read = () => ({
      mode: host.supported ? { selected: host.selected, available: [{ id: ':workspace', name: '编辑', description: '工作区权限' }, { id: ':danger-full-access', name: '完全访问', description: '保留原生权限含义' }, ...(host.review ? [{ id: 'auto-review', name: 'AI 帮我审', description: '原生审查' }] : [])] } : null,
      model: { selected: 'native-model', available: [{ id: 'native-model', name: 'Native Codex model' }] },
      effort: null,
      fast: null,
      modelMenu: { agentName: 'Codex', conversationSelection: null, platformModels: [], ownCatalog: null, ownAuth: null },
    })
    return { read: async () => read(), set: async (dimension: string, value: string) => {
      host.set(dimension, value)
      if (host.fail) throw new Error('Permission update rejected')
      if (dimension === 'mode') host.selected = value
      return read()
    } }
  },
}))
let harness: ReturnType<typeof createReactHarness> | undefined
let dispose: (() => void) | undefined
let bodyClass = ''
let bodyStyle: string | null = null
const Conversation = observer(({ withWork = true }: { withWork?: boolean }) => {
  const sidebar = usePhoneSessionSidebar({ sessionId: 'room-task', entry: 'chat:room' })
  return <AgentWatchScreen title="权限验收任务" testId="permission-phone-work" bodyFill><SessionConversation
    timeline={emptyAgentWatchTimeline()} deviceId="qa-permission-device" sessionId="room-task" agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} permissionsInWork
    composerControls={withWork && sidebar.anchor ? (modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} /> : undefined}
  /></AgentWatchScreen>
})
async function mount({ withWork = true, width = 390 }: { withWork?: boolean; width?: number } = {}) {
  followRendererSession('SIGNED_IN', 'owner')
  await page.viewport(width, 844)
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.setAttribute('data-phone-shell', '')
  bodyClass = document.body.className
  bodyStyle = document.body.getAttribute('style')
  document.body.classList.add('bg-background', 'gugu-skin', 'emdark')
  document.body.style.background = 'var(--background)'
  setLocalePreference('zh-CN')
  const chats = [chat({ id: 'room', kind: 'group', name: '权限验收群' })]
  publishChatSummaries(chats)
  dispose = installOwnedAgentEntry({ open: () => false, owns: () => true })
  publishDirectoryDevices([device('qa-permission-device', [], { is_online: true })])
  updateDeviceSessions('qa-permission-device', { projects: [{ id: 'workspace', name: 'Tasks', path: '', kind: 'workspace' }], sessions: [
    { conversationId: 'room-task', title: '权限验收任务', agent: { userId: 'room-agent' }, bornInChatId: 'room', projectId: 'workspace', harness: 'codex', runtime: 'acp', agentStatus: 'idle' } as SessionpageSessionSummary,
  ], cached: false, loading: false, error: null })
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', padding: '16px' })
  await renderWithAppProviders(harness, <LocalizationProvider><SessionUiTheme theme="dark"><Conversation withWork={withWork} /></SessionUiTheme></LocalizationProvider>,
    { auth: { id: 'owner' }, chat: { chats }, contacts: { contacts: [] } })
  await until('native mode options read', () => host.supported
    ? !!document.querySelector('[data-slot="composer-permission-mode"]') || !!document.querySelector('[data-testid="agent-watch-create-model-device"]')
    : !!document.querySelector('[data-testid="agent-watch-create-model-device"]'))
}
afterEach(() => {
  harness?.cleanup(); dispose?.(); removeDeviceSessions('qa-permission-device'); publishDirectoryDevices([])
  document.documentElement.removeAttribute('data-phone-shell')
  document.body.className = bodyClass
  if (bodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', bodyStyle)
  host.set.mockClear(); host.supported = true; host.selected = ':danger-full-access'; host.fail = false; host.review = false
})


async function openPermissions() {
  await page.getByTestId('agent-watch-create-model-device').click()
  const drill = page.getByRole('button', { name: /权限.*完全访问/ })
  await expect.element(drill).toHaveTextContent('完全访问')
  expect(document.querySelector('[data-slot="composer-permission-mode"]')).toBeNull()
  await drill.click()
}

it('moves the actual phone conversation permissions into Work and sends the original native mode id once', async () => {
  await mount()
  await openPermissions()
  const selected = page.getByRole('radio', { name: /完全访问/ })
  await expect.element(selected).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: '__screenshots__/phone-work-permission-options.png' })
  await page.getByRole('radio', { name: /编辑/ }).click()
  await until('accepted native mode is shown in Work', () => document.querySelector('[data-dimension="permission"][data-testid="agent-watch-create-options-drill"]')?.textContent?.includes('编辑') === true)
  expect(host.set).toHaveBeenCalledTimes(1)
  expect(host.set).toHaveBeenCalledWith('mode', ':workspace')
  expect(document.querySelector('[data-slot="composer-permission-mode"]')).toBeNull()
  await page.screenshot({ path: '__screenshots__/phone-work-permission-selected.png' })
})

it('keeps a rejected change on the original mode and retains the existing error notice', async () => {
  host.fail = true
  await mount()
  await openPermissions()
  await page.getByRole('radio', { name: /编辑/ }).click()
  await until('host rejection is visible', () => document.body.textContent?.includes('Permission update rejected') === true)
  expect(host.selected).toBe(':danger-full-access')
  expect(host.set).toHaveBeenCalledTimes(1)
  expect(host.set).toHaveBeenCalledWith('mode', ':workspace')
  expect(document.querySelector('[data-dimension="permission"][data-testid="agent-watch-create-options-drill"]')?.textContent).toContain('完全访问')
})

it('retains the phone composer permission selector when there is no Work owner', async () => {
  await mount({ withWork: false })
  await until('fallback permission selector visible', () => !!document.querySelector('[data-slot="composer-permission-mode"]'))
  expect(document.querySelector('[data-slot="composer-permission-mode"]')?.textContent).toContain('完全访问')
  expect(host.set).not.toHaveBeenCalled()
})

it('retains the desktop composer permission selector even when Work ownership is requested', async () => {
  await mount({ width: 1100 })
  await until('desktop permission selector visible', () => !!document.querySelector('[data-slot="composer-permission-mode"]'))
  expect(document.querySelector('[data-slot="composer-permission-mode"]')?.textContent).toContain('完全访问')
  expect(host.set).not.toHaveBeenCalled()
})

it('does not invent permission choices when the host supplies no switchable mode group', async () => {
  host.supported = false
  await mount()
  await page.getByTestId('agent-watch-create-model-device').click()
  expect(document.querySelector('[data-dimension="permission"]')).toBeNull()
  expect(document.querySelector('[data-slot="composer-permission-mode"]')).toBeNull()
  expect(host.set).not.toHaveBeenCalled()
})

it('carries an admitted native Auto option through Work and reflects only the accepted host mode', async () => {
  host.review = true
  await mount()
  await openPermissions()
  await page.getByRole('radio', { name: /AI 帮我审/ }).click()
  await until('accepted Auto mode is shown in Work', () => document.querySelector('[data-dimension="permission"][data-testid="agent-watch-create-options-drill"]')?.textContent?.includes('AI 帮我审') === true)
  expect(host.set).toHaveBeenCalledExactlyOnceWith('mode', 'auto-review')
  expect(host.selected).toBe('auto-review')
  expect(document.querySelector('[data-slot="composer-permission-mode"]')).toBeNull()
})

it('does not offer Auto in Work when the host excludes it', async () => {
  await mount()
  await openPermissions()
  await expect.element(page.getByRole('radio', { name: /AI 帮我审/ })).not.toBeInTheDocument()
  expect(host.set).not.toHaveBeenCalled()
})

it('retains the original mode when the host rejects Auto in Work', async () => {
  host.review = true
  host.fail = true
  await mount()
  await openPermissions()
  await page.getByRole('radio', { name: /AI 帮我审/ }).click()
  await until('Auto rejection is visible', () => document.body.textContent?.includes('Permission update rejected') === true)
  expect(host.set).toHaveBeenCalledExactlyOnceWith('mode', 'auto-review')
  expect(host.selected).toBe(':danger-full-access')
  expect(document.querySelector('[data-dimension="permission"][data-testid="agent-watch-create-options-drill"]')?.textContent).toContain('完全访问')
})
