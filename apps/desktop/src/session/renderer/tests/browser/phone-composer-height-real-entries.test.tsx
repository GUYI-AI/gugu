import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Both creation and existing Thread entry use production page/composer UI.
// Only account/device/catalog and submission transports are controlled. Zero
// creation/model/upload requests; a draft toggle is not a native provider ACK.
const fixture = vi.hoisted(() => ({
  owner: 'FGH-owner', fast: true, models: vi.fn(),
  unexpectedRpc: vi.fn((name: string): never => { throw new Error(`Unexpected H transport call: ${name}`) }),
  device: { device_id: 'FGH-device', label: '隔离验收设备', hostname: 'fixture', platform: 'darwin',
    status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z',
    capabilities: { terminals: [], runtimes: ['codex'] } },
  create: vi.fn(() => { throw new Error('Submission forbidden in renderer capture') }),
}))
vi.mock('@/store/auth', async original => ({ ...await original<typeof import('@/store/auth')>(), useAuth: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => fixture.device.label, isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({
  rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }),
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async importOriginal => {
  const actual = await importOriginal<typeof import('@/mobile/agent-watch/sessionpage-rpc')>()
  // Preserve the complete production export surface for the real Thread import
  // graph. Every unused RPC remains closed: import compatibility is not permission
  // to open a native connection, fetch a file/image, or start a background task.
  const closed = Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    typeof value === 'function' && name !== 'SessionpageRpcError' ? () => fixture.unexpectedRpc(name) : value,
  ]))
  return {
    ...actual,
    ...closed,
    SessionpageRpcError: class extends Error { code = 'fixture' },
    fetchCreateOptions: async () => ({ projects: [],
      lastUsed: { projectId: 'workspace', harness: 'codex', sessionView: 'general', permissionMode: null, model: 'native:sol', effort: 'medium' },
      harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
    fetchCreateModels: fixture.models, createSession: fixture.create,
    fetchPhoneCreateOptions: vi.fn(), fetchPhoneCreateModels: vi.fn(), createPhoneSession: fixture.create,
  }
})
let harness: ReturnType<typeof createReactHarness> | undefined
let root: Root | null = null, host: HTMLDivElement | null = null, sequence = 0
let oldBodyStyle: string | null = null
beforeEach(() => {
  fixture.owner = `FGH-owner-${++sequence}`; fixture.fast = true
  fixture.models.mockReset(); fixture.create.mockClear(); fixture.unexpectedRpc.mockClear()
  fixture.models.mockImplementation(async (_device: string, _harness: string, _leg: unknown, selected: string | null) => ({
    harness: 'codex', transport: 'acp', selected: selected ?? 'native:sol', selectedEffort: 'medium',
    harnessState: 'ready', harnessReason: null, guguReason: null, harnessAuth: 'signed-in', selectedCredential: 'credentialed',
    efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
    models: [{ id: 'native:sol', name: 'GPT-6.1-Sol', source: 'harness' }, { id: 'sonnet', name: 'Original alias', source: 'harness' }],
    ...(fixture.fast ? { fast: { model: 'native:sol', selected: 'on', available: [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }] } } : {}),
  }))
})
afterEach(() => {
  root?.unmount(); harness?.cleanup(); harness = undefined; host?.remove(); root = null; host = null
  composerDrafts.discard(mobileCreationDraftKey(fixture.owner))
  document.documentElement.removeAttribute('data-theme')
  if (oldBodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', oldBodyStyle)
})
const editor = () => host!.querySelector<HTMLElement>('[contenteditable]')!
async function mount(width: number, theme: 'light' | 'dark') {
  await page.viewport(width, 844); setLocalePreference('zh-CN')
  writeThemePreference(theme)
  oldBodyStyle = document.body.getAttribute('style')
  document.body.style.background = 'var(--ta-panel-bg)'
  followRendererSession('SIGNED_IN', fixture.owner)
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''; host.dataset.taScope = ''
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ta-panel-bg)'
  root = createRoot(host)
  root.render(<ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <CreateSessionPage onCreated={fixture.create} />
  </MessageProvider></SessionUiTheme></LocalizationProvider></ThemeProvider>)
  await until('real creation editor', () => !!host?.querySelector('[contenteditable]'))
  expect(host.textContent).toContain('新建任务')
  expect(host.textContent).not.toContain('agentWatch.')
  await document.fonts.ready
}

vi.mock('@/components/assistant/assistantTimelineClient', async original => ({
  ...await original<typeof import('@/components/assistant/assistantTimelineClient')>(),
  conversationOptionClient: () => ({
    read: async () => ({ mode: null, model: null, effort: null, fast: null, modelMenu: null }),
    set: async () => { throw new Error('No setting action in H capture') },
  }),
}))
async function mountExisting(width: number, theme: 'light' | 'dark') {
  await page.viewport(width, 844); setLocalePreference('zh-CN'); writeThemePreference(theme)
  oldBodyStyle = document.body.getAttribute('style'); document.body.style.background = 'var(--ta-panel-bg)'
  harness = createReactHarness(); host = harness.container; host.dataset.phoneShell = ''; host.dataset.taScope = ''
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ta-panel-bg)'
  await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}>
    <AgentWatchScreen title="两行高度验收任务" testId="H-existing-task" bodyFill>
      <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="FGH-device" sessionId="H-existing-session"
        agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
        respondingItemId={null} onRespond={vi.fn()} onSend={fixture.create} pendingSends={[]} sending={false}
        agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />
    </AgentWatchScreen>
  </SessionUiTheme></LocalizationProvider></ThemeProvider>, { auth: { id: fixture.owner }, contacts: {} })
  await until('actual existing Thread editor', () => !!host?.querySelector('[contenteditable]'))
  await document.fonts.ready
}
async function capture(name: string) {
  expect(document.body.textContent).not.toMatch(/agentWatch\.|shell\./)
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/${name}.png` })
}
// This is renderer geometry/retained-draft evidence. Native keyboard/IME and a
// launched host remain separate; neither mount sends a task or uploads a File.
for (const entry of ['new-page', 'existing-thread'] as const)
  for (const width of [320, 390]) for (const theme of ['light', 'dark'] as const) {
    it(`${entry}/${width}/${theme}: two lines retain natural height and separate touch targets in the actual Thread`, async () => {
      if (entry === 'new-page') await mount(width, theme)
      else await mountExisting(width, theme)
      await until(`${entry} actual Thread editor engine ready`, () => !!(editor() as HTMLElement & { editor?: unknown })?.editor)
      const original = editor()
      const engine = (original as HTMLElement & { editor: { commands: { setContent(html: string): void } } }).editor
      const capsule = host!.querySelector<HTMLElement>('[data-phone-capsule]')!
      const input = capsule.querySelector<HTMLElement>('[data-slot="composer-input"]')!
      const line = Number.parseFloat(getComputedStyle(original).lineHeight)
      const padding = Number.parseFloat(getComputedStyle(input).paddingTop) + Number.parseFloat(getComputedStyle(input).paddingBottom)
      expect(line).toBeGreaterThan(0)
      const lines = async (count: number) => {
        engine.commands.setContent(Array.from({ length: count }, (_, i) => `<p>第${i + 1}行</p>`).join(''))
        await until(`${entry} ${count} line state`, () => original.children.length === count
          && capsule.hasAttribute('data-phone-multiline') === (count > 1)
          && capsule.hasAttribute('data-phone-attachment-row') === (count > 2))
      }
      await lines(1)
      const one = input.getBoundingClientRect().height
      expect(Math.abs(one - (line + padding))).toBeLessThanOrEqual(1)
      await lines(2)
      await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - (2 * line + padding))).toBeLessThanOrEqual(1))
      expect(input.scrollHeight).toBeLessThanOrEqual(input.clientHeight + 1)
      const expand = capsule.querySelector<HTMLElement>('[data-phone-editor-toggle]')!, send = capsule.querySelector<HTMLElement>('[data-phone-send]')!
      expect(expand.getBoundingClientRect().height).toBeGreaterThanOrEqual(32)
      expect(send.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
      expect(expand.getBoundingClientRect().bottom).toBeLessThanOrEqual(send.getBoundingClientRect().top + 0.5)
      await capture(`H-${entry}-two-lines-${width}-${theme}`)
      await lines(3)
      await vi.waitFor(() => expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(128))
      await capture(`H-${entry}-three-lines-${width}-${theme}`)
      await lines(2)
      await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - (2 * line + padding))).toBeLessThanOrEqual(1))
      await lines(1)
      await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - one)).toBeLessThanOrEqual(1))
      expect(editor()).toBe(original)
      expect(fixture.create).not.toHaveBeenCalled()
      expect(fixture.unexpectedRpc).not.toHaveBeenCalled()
    })
  }
