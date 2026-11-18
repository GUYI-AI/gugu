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

const host = vi.hoisted(() => ({ set: vi.fn(), read: vi.fn(), catalogReady: null as Promise<void> | null, normal: false, supported: true, fast: 'off', effort: 'medium', selected: 'native-model', canSwitch: true }))
vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => {
    const read = (includeOwnModels?: true) => ({
      mode: null,
      model: { selected: host.selected, available: host.normal ? normalCodexModelRows.map(({ id, name, description }) => ({ id, name, description })) : [{ id: 'native-model', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.' }, { id: 'sonnet', name: 'Alternative native model', description: 'A second advertised model with the original alias.' }] },
      effort: { selected: host.effort, available: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
      fast: host.supported ? { selected: host.fast, available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] } : null,
      modelMenu: { agentName: 'Codex', conversationSelection: null, platformModels: [], ownAuth: null,
        ownCatalog: includeOwnModels && host.catalogReady ? {
          kind: 'ready', models: [{ id: 'new-model', name: 'New Codex Model' }], selected: 'new-model', efforts: [], selectedEffort: null,
        } : null,
        // Exact Codex metadata contract; omitting it correctly disables live changes.
        ...(host.canSwitch ? { liveSetting: { channel: 'provider-thread-settings', ack: 'ack-read-back', busy: 'queue-next-turn', reloadRequired: false, recovery: 'none' } } : {}),
      },
    })
    return { read: async (includeOwnModels?: true) => {
      host.read(includeOwnModels)
      if (includeOwnModels) await host.catalogReady
      return read(includeOwnModels)
    }, set: async (dimension: string, value: string) => {
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
  host.set.mockClear(); host.read.mockClear(); host.catalogReady = null; host.supported = true; host.fast = 'off'; host.effort = 'medium'; host.selected = 'native-model'; host.canSwitch = true; host.normal = false
})

it('opening an existing phone model menu keeps the current selection and adds the refreshed host model to the search results', async () => {
  let releaseCatalog!: () => void
  host.catalogReady = new Promise<void>(resolve => { releaseCatalog = resolve })
  await mount('dark')
  expect(host.read.mock.calls).toEqual([[undefined]])
  await page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  const current = '[data-dimension="model"][data-option-id="native-model"]'
  await until('the cached selection remains visible', () => document.querySelector(current)?.getAttribute('aria-checked') === 'true')
  const search = document.querySelector<HTMLInputElement>('.gg-aw-model-search input')!
  await page.elementLocator(search).fill('New Codex')
  expect(document.querySelector('[data-option-id="new-model"]')).toBeNull()
  releaseCatalog()
  await until('the refreshed model matches the existing search', () => !!document.querySelector('[data-option-id="new-model"]'))
  expect(search.value).toBe('New Codex')
  expect(host.read.mock.calls).toEqual([[undefined], [true]])
  expect(host.set).not.toHaveBeenCalled()
  expect(host.selected).toBe('native-model')
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
  expect(row('native-model').hasAttribute('data-selected')).toBe(true)
  expect(row('native-model').querySelector(':scope > svg')).not.toBeNull()
  expect(row('sonnet').hasAttribute('data-selected')).toBe(false)
  expect(row('sonnet').querySelector(':scope > svg')).toBeNull()
  const label = row('native-model').querySelector<HTMLElement>('.gg-phone-composer-choice-name')!
  const detail = row('native-model').querySelector<HTMLElement>('.gg-phone-composer-choice-description')!
  expect(label.textContent).toBe('GPT-6.1-Sol')
  expect(detail.textContent).toBe('适合编程和日常任务')
  expect(getComputedStyle(label.parentElement!).flexDirection).toBe('row')
  expect(Math.abs(detail.getBoundingClientRect().top - label.getBoundingClientRect().top)).toBeLessThanOrEqual(4)
  expect(getComputedStyle(label).whiteSpace).toBe('nowrap')
  expect(getComputedStyle(detail).whiteSpace).toBe('nowrap')
  expect(getComputedStyle(detail).textOverflow).toBe('ellipsis')
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
  expect(row.querySelector('.gg-phone-composer-choice-description')?.textContent).toBe(translateSessionMessage('chat.modelSwitchUnsupportedHint'))
  expect(host.set).not.toHaveBeenCalled()
})

it.each(['light', 'dark'] as const)('%s: normal production catalog at the real existing entry preserves CLI selection and readback', async theme => {
  host.normal = true; host.selected = normalCodexSelectedId
  await mount(theme)
  const openModels = async () => page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-dimension="model"][data-option-id="${id}"]`)!
  await openModels()
  await until('normal native ID is selected in existing Work', () => row(normalCodexSelectedId)?.getAttribute('aria-checked') === 'true')
  const localizedDetails = ['适合复杂编程任务', '适合日常编程']
  for (const [index, model] of normalCodexModelRows.entries()) {
    const label = row(model.id).querySelector<HTMLElement>('.gg-phone-composer-choice-name')!
    const detail = row(model.id).querySelector<HTMLElement>('.gg-phone-composer-choice-description')!
    expect(label.textContent).toBe(model.name); expect(detail.textContent).toBe(localizedDetails[index])
    expect(getComputedStyle(label.parentElement!).flexDirection).toBe('row')
    expect(Math.abs(detail.getBoundingClientRect().top - label.getBoundingClientRect().top)).toBeLessThanOrEqual(4)
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(detail).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(detail).textOverflow).toBe('ellipsis')
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
