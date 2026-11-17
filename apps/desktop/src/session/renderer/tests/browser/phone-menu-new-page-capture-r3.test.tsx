import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateRequest, SessionpageSessionCreateResult } from '@gugu/session-core/session-record/contract'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Fixture source: phone-create-thinking-fast-real-page.test.tsx at d7cd6183.
// Keep CreateSessionPage -> Thread -> CreateTarget -> PhoneThinkingOptions real.
// Account/device/catalog and the submission transport are controlled boundaries.
// Submission is deliberately rejected at that boundary: no real host, model,
// upload, native acceptance or provider acknowledgement is simulated as success.
const fixture = vi.hoisted(() => ({
  owner: 'DE-new-owner', supported: true,
  device: { device_id: 'create-FG-device', label: '隔离验收设备', hostname: 'fixture', platform: 'linux',
    status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } },
  models: vi.fn<(device: string, harness: string, leg: unknown, selected: string | null) => Promise<SessionpageSessionCreateModels>>(),
  create: vi.fn<(device: string, request: SessionpageSessionCreateRequest) => Promise<SessionpageSessionCreateResult>>(),
  created: vi.fn(),
}))
vi.mock('@/store/auth', async original => ({ ...await original<typeof import('@/store/auth')>(), useAuth: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => fixture.device.label, isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({
  rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }),
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { code = 'fixture' },
  machineRpc: () => { throw new Error('Skills RPC is outside this thinking/Fast test') },
  fetchCreateOptions: async () => ({ projects: [],
    lastUsed: { projectId: 'workspace', harness: 'codex', sessionView: 'general', permissionMode: null, model: 'native:sol', effort: 'medium' },
    harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
  fetchCreateModels: fixture.models, createSession: fixture.create,
  fetchPhoneCreateOptions: vi.fn(), fetchPhoneCreateModels: vi.fn(), createPhoneSession: fixture.create,
}))
let root: Root | null = null, host: HTMLDivElement | null = null, sequence = 0
beforeEach(() => {
  fixture.owner = `DE-new-owner-${++sequence}`; fixture.supported = true
  fixture.created.mockReset(); fixture.create.mockReset(); fixture.models.mockReset()
  fixture.create.mockRejectedValue(Object.assign(new Error('Controlled submission boundary rejection'), { code: 'fixture_submission_rejected' }))
  fixture.models.mockImplementation(async (_device, harness, _leg, selected) => ({
    harness, transport: 'acp', selected: selected ?? 'native:sol', selectedEffort: 'medium',
    harnessState: 'ready', harnessReason: null, guguReason: null, harnessAuth: 'signed-in', selectedCredential: 'credentialed',
    efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
    models: [{ id: 'native:sol', name: 'GPT-6.1-Sol', source: 'harness' }, { id: 'sonnet', name: 'Original alias', source: 'harness' }],
    // Deliberately reports selected=on: new creation must still default OFF.
    ...(fixture.supported && selected === 'native:sol' ? { fast: {
      model: 'native:sol', selected: 'on', available: [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }],
    } } : {}),
  }))
})
afterEach(() => {
  root?.unmount(); host?.remove(); root = null; host = null
  composerDrafts.discard(mobileCreationDraftKey(fixture.owner))
  document.documentElement.removeAttribute('data-theme')
})
const editor = () => host!.querySelector<HTMLElement>('[contenteditable]')!
async function mount(width: number, theme: 'light' | 'dark') {
  await page.viewport(width, 844); setLocalePreference('zh-CN'); writeThemePreference(theme)
  followRendererSession('SIGNED_IN', fixture.owner)
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''; host.dataset.taScope = ''
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ta-panel-bg)'
  root = createRoot(host)
  root.render(<ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <CreateSessionPage onCreated={fixture.created} />
  </MessageProvider></SessionUiTheme></LocalizationProvider></ThemeProvider>)
  await until('real creation editor', () => !!host?.querySelector('[contenteditable]'))
  expect(host.textContent).toContain('新建任务')
  expect(editor().getAttribute('aria-label')).toBe('第一句话…')
  expect(host.textContent).not.toContain('agentWatch.')
  await document.fonts.ready
  await until('production shell theme applied', () => document.documentElement.dataset.theme === theme)
}

// D/E capture only: real pages and production portal remain mounted. The
// account/directory/catalog/transport are controlled; no host or send is run.
const deHost = () => host!
const deRow = () => deHost().querySelector<HTMLElement>('[data-phone-composer-controls]')!
const deWork = () => deHost().querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-model-device"]')!
const dePanel = () => document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')
function assertDirection(open: boolean) {
  const button = deWork()
  expect(button.textContent).toBe('工作')
  expect(button.getAttribute('aria-expanded')).toBe(String(open))
  expect(button.querySelectorAll('svg')).toHaveLength(1)
  expect(button.querySelector('svg[data-phone-menu-direction]')?.getAttribute('data-phone-menu-direction')).toBe(open ? 'down' : 'up')
  expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
}
async function panelReady() {
  await until('real page popup settled', () => !!dePanel() && getComputedStyle(dePanel()!).opacity === '1')
  await Promise.all(dePanel()!.getAnimations().map(a => a.finished))
  const panel = dePanel()!, close = panel.querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-controls-sheet-close"]')!
  expect(close.getAttribute('aria-label')).toBe('关闭')
  const p = panel.getBoundingClientRect(), c = close.getBoundingClientRect()
  expect(c.height).toBeGreaterThanOrEqual(44); expect(c.width).toBeGreaterThanOrEqual(44)
  expect(c.left).toBeGreaterThanOrEqual(p.left + p.width / 2)
  expect(c.right).toBeLessThanOrEqual(p.right)
  expect(c.top).toBeGreaterThanOrEqual(p.top)
  expect(c.bottom).toBeLessThanOrEqual(p.top + 60)
  assertDirection(true)
}
function assertVisibleRow() {
  const row = deRow(), items = row.querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
  expect(row.hasAttribute('data-editing')).toBe(false); expect(row.inert).toBe(false)
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  if (!items.hidden) expect(items.scrollWidth).toBeLessThanOrEqual(items.clientWidth)
  expect(row.getBoundingClientRect().height).toBeGreaterThan(40)
}
function assertDisclosure(expanded: boolean) {
  const row = deRow(), toggle = row.querySelector<HTMLButtonElement>('[data-testid="phone-composer-menu-toggle"]')!
  expect(toggle.getAttribute('aria-expanded')).toBe(String(expanded))
  expect(toggle.getAttribute('aria-label')).toBe(expanded ? '收起输入框菜单栏' : '展开输入框菜单栏')
  const box = toggle.getBoundingClientRect(), pseudo = getComputedStyle(toggle, '::after'), outer = row.getBoundingClientRect()
  const left = box.left + parseFloat(pseudo.left), right = box.right - parseFloat(pseudo.right)
  expect(right - left).toBe(44)
  expect(box.height - parseFloat(pseudo.top) - parseFloat(pseudo.bottom)).toBe(44)
  expect(left).toBeGreaterThanOrEqual(outer.left); expect(right).toBeLessThanOrEqual(outer.right)
  expect(document.elementFromPoint(right - 1, box.top + box.height / 2)?.closest('button')).toBe(toggle)
}
async function deCapture(group: 'D' | 'E', phase: string, width: number, theme: 'light' | 'dark') {
  expect(document.body.textContent).not.toMatch(/agentWatch\.|shell\./)
  assertVisibleRow()
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/${group}-new-page-${phase}-${width}-${theme}.png` })
}
for (const width of [320, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: actual new-page page shows menu directions, root and model child Close, and retained draft disclosure`, async () => {
    await mount(width, theme)
    const original = deHost().querySelector<HTMLElement>('[contenteditable]')!
    const engine = (original as HTMLElement & { editor: { commands: { setContent(html: string): void; clearContent(emit: boolean): void } } }).editor
    original.blur()
    await until('real empty menu available', () => !!deWork() && !deRow().hasAttribute('data-editing'))
    await document.fonts.ready
    assertDirection(false); assertDisclosure(true)
    await deCapture('D', 'before-up', width, theme)
    await page.getByTestId('agent-watch-create-model-device').click(); await panelReady()
    expect(dePanel()!.querySelector('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')).not.toBeNull()
    await deCapture('E', 'root-down-close', width, theme)
    await page.elementLocator(dePanel()!.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
    await until('actual model child rendered', () => !!dePanel()?.querySelector('[data-dimension="model"][data-option-id="native:sol"]'))
    await panelReady()
    await deCapture('E', 'child-down-close', width, theme)
    await page.getByTestId('agent-watch-create-controls-sheet-close').click()
    await until('actual child Close removes popup', () => dePanel() === null)
    assertDirection(false); expect(deHost().querySelector('[contenteditable]')).toBe(original)
    await deCapture('D', 'child-x-closed-up', width, theme)
    await page.getByTestId('agent-watch-create-model-device').click(); await panelReady()
    await page.getByTestId('agent-watch-create-controls-sheet-close').click()
    await until('actual root Close removes popup', () => dePanel() === null)
    assertDirection(false)
    await deCapture('E', 'root-x-closed-up', width, theme)
    try {
      engine.commands.setContent('<p>关闭菜单仍保留的草稿</p>'); original.blur()
      await until('real draft keeps collapsed disclosure', () => deRow().hasAttribute('data-collapsed') && !deRow().hasAttribute('data-editing'))
      expect(original.textContent).toBe('关闭菜单仍保留的草稿'); assertDisclosure(false)
      await deCapture('D', 'draft-collapsed-row-up', width, theme)
      await page.getByTestId('phone-composer-menu-toggle').click()
      await until('manual disclosure expands real controls', () => !deRow().hasAttribute('data-collapsed'))
      expect(original.textContent).toBe('关闭菜单仍保留的草稿')
      expect(deHost().querySelector('[contenteditable]')).toBe(original)
      assertDirection(false); assertDisclosure(true)
      await deCapture('D', 'draft-expanded-row-down', width, theme)
    } finally { engine.commands.clearContent(true) }
    expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.created).not.toHaveBeenCalled()
  })
}
