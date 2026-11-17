import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome'
import { PhoneSessionSidebarControls } from '@/mobile/chat/PhoneSessionSidebarControls'
import { usePhoneSessionSidebar } from '@/mobile/chat/usePhoneSessionSidebar'
import { followRendererSession } from '@/lib/replica'
import { translateSessionMessage } from '@renderer/localization/locale-store'
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
import { normalCodexModelRows, normalCodexSelectedId, normalCodexAlternativeId } from './fixtures/phone-normal-model-catalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/i18n/registerMainCatalog'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const host = vi.hoisted(() => ({ set: vi.fn(), normal: false, supported: true, fast: 'off', effort: 'medium', selected: 'native-model', canSwitch: true }))
vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => {
    const read = () => ({
      mode: null,
      model: { selected: host.selected, available: host.normal ? normalCodexModelRows.map(({ id, name, description }) => ({ id, name, description })) : [{ id: 'native-model', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.' }, { id: 'sonnet', name: 'Alternative native model', description: 'A second advertised model with the original alias.' }] },
      effort: { selected: host.effort, available: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
      fast: host.supported ? { selected: host.fast, available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] } : null,
      modelMenu: { agentName: 'Codex', conversationSelection: null, platformModels: [], ownCatalog: null, ownAuth: null,
        // Exact Codex metadata contract; omitting it correctly disables live changes.
        ...(host.canSwitch ? { liveSetting: { channel: 'provider-thread-settings', ack: 'ack-read-back', busy: 'queue-next-turn', reloadRequired: false, recovery: 'none' } } : {}),
      },
    })
    return { read: async () => read(), set: async (dimension: string, value: string) => {
      host.set(dimension, value)
      if (dimension === 'model') host.selected = value
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
  return <AgentWatchScreen title="模型验收任务" testId="model-phone-work" bodyFill><SessionConversation
    timeline={emptyAgentWatchTimeline()} deviceId="qa-model-device" sessionId="room-task" agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
    composerControls={sidebar.anchor ? (modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} /> : undefined}
  /></AgentWatchScreen>
})
async function mount(theme: 'light' | 'dark') {
  followRendererSession('SIGNED_IN', 'owner')
  await page.viewport(320, 640)
  writeThemePreference(theme)
  document.documentElement.setAttribute('data-phone-shell', '')
  bodyClass = document.body.className
  bodyStyle = document.body.getAttribute('style')
  document.body.classList.add('bg-background', 'gugu-skin', theme === 'light' ? 'emlight' : 'emdark')
  document.body.style.background = 'var(--background)'
  setLocalePreference('zh-CN')
  const chats = [chat({ id: 'room', kind: 'group', name: '模型验收群' })]
  publishChatSummaries(chats)
  dispose = installOwnedAgentEntry({ open: () => false, owns: () => true })
  publishDirectoryDevices([device('qa-model-device', [], { is_online: true })])
  updateDeviceSessions('qa-model-device', { projects: [{ id: 'workspace', name: 'Tasks', path: '', kind: 'workspace' }], sessions: [
    { conversationId: 'room-task', title: '模型验收任务', agent: { userId: 'room-agent' }, bornInChatId: 'room', projectId: 'workspace', harness: 'codex', runtime: 'acp', agentStatus: 'idle' } as SessionpageSessionSummary,
  ], cached: false, loading: false, error: null })
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', padding: '16px' })
  await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><Conversation /></SessionUiTheme></LocalizationProvider></ThemeProvider>,
    { auth: { id: 'owner' }, chat: { chats }, contacts: { contacts: [] } })
  await page.getByTestId('agent-watch-create-model-device').click()
  await until('phone Work reads the model setting', () => !!document.querySelector('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]'))
  await until('phone Work is fully visible', () => getComputedStyle(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!).opacity === '1')
  await Promise.all(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')!.getAnimations().map(animation => animation.finished))
  await document.fonts.ready
}
afterEach(() => {
  harness?.cleanup(); dispose?.(); removeDeviceSessions('qa-model-device'); publishDirectoryDevices([])
  document.documentElement.removeAttribute('data-phone-shell')
  document.documentElement.removeAttribute('data-theme')
  document.body.className = bodyClass
  if (bodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', bodyStyle)
  host.set.mockClear(); host.supported = true; host.fast = 'off'; host.effort = 'medium'; host.selected = 'native-model'; host.canSwitch = true; host.normal = false
})

// Only the external option-client response is a fixture; the conversation,
// sidebar anchor, Work page, model assembly, portal and callbacks remain real.
it.each(['light', 'dark'] as const)('%s: existing session Work separates model copy and confirms the original picked alias', async theme => {
  await mount(theme)
  const openModels = async () => page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  await openModels()
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-dimension="model"][data-option-id="${id}"]`)!
  await until('selected native row in the actual Work sheet', () => row('native-model')?.getAttribute('aria-checked') === 'true')
  expect(row('native-model').closest('.gg-aw')).toBeNull()
  const label = row('native-model').querySelector<HTMLElement>('.gg-aw-choice-label')!
  const detail = row('native-model').querySelector<HTMLElement>('.gg-aw-choice-desc')!
  expect(label.textContent).toBe('GPT-6.1-Sol')
  expect(detail.textContent).toBe('Latest workhorse model for coding and everyday work.')
  expect(getComputedStyle(label.parentElement!).flexDirection).toBe('column')
  expect(detail.getBoundingClientRect().top).toBeGreaterThanOrEqual(label.getBoundingClientRect().bottom)
  expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth)
  await page.screenshot({ path: `__screenshots__/internal-phone-model-pressure/B-existing-model-${theme}-320.png` })
  await page.elementLocator(row('sonnet')).click()
  await until('the original alias reaches the real setting callback', () => host.set.mock.calls.some(([dimension, value]) => dimension === 'model' && value === 'sonnet'))
  await openModels()
  await until('host response selects the original alias', () => row('sonnet')?.getAttribute('aria-checked') === 'true')
  await page.screenshot({ path: `__screenshots__/internal-phone-model-pressure/B-existing-model-selected-${theme}-320.png` })
  expect(host.set.mock.calls).toEqual([['model', 'sonnet']])
})

it('keeps an undeclared live model channel disabled with its actual reason', async () => {
  host.canSwitch = false
  await mount('dark')
  await page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  const row = document.querySelector<HTMLButtonElement>('[data-dimension="model"][data-option-id="native-model"]')!
  await until('undeclared live channel is disabled', () => row?.disabled === true)
  expect(row.querySelector('.gg-aw-choice-desc')?.textContent).toBe(translateSessionMessage('chat.modelSwitchUnsupportedHint'))
  expect(host.set).not.toHaveBeenCalled()
})

it.each(['light', 'dark'] as const)('%s: normal production catalog at the real existing entry preserves CLI selection and readback', async theme => {
  host.normal = true; host.selected = normalCodexSelectedId
  await mount(theme)
  const openModels = async () => page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-dimension="model"][data-option-id="${id}"]`)!
  await openModels()
  await until('normal native ID is selected in existing Work', () => row(normalCodexSelectedId)?.getAttribute('aria-checked') === 'true')
  for (const model of normalCodexModelRows) {
    const label = row(model.id).querySelector<HTMLElement>('.gg-aw-choice-label')!
    const detail = row(model.id).querySelector<HTMLElement>('.gg-aw-choice-desc')!
    expect(label.textContent).toBe(model.name); expect(detail.textContent).toBe(model.description)
    expect(getComputedStyle(label.parentElement!).flexDirection).toBe('column')
    expect(detail.getBoundingClientRect().top).toBeGreaterThanOrEqual(label.getBoundingClientRect().bottom)
    expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth)
  }
  expect(document.body.textContent).not.toMatch(/agentWatch\.|Unchanged alias|Alternative native model|a{30}/)
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/B-normal-existing-model-${theme}-320.png` })
  await page.elementLocator(row(normalCodexAlternativeId)).click()
  await until('normal raw CLI ID reaches actual model setter', () => host.set.mock.calls.some(([dimension, value]) => dimension === 'model' && value === normalCodexAlternativeId))
  await openModels()
  await until('normal native response ID is read back', () => row(normalCodexAlternativeId)?.getAttribute('aria-checked') === 'true')
  expect(host.set.mock.calls).toEqual([['model', normalCodexAlternativeId]])
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/B-normal-existing-model-selected-${theme}-320.png` })
})
