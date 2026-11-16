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

// Frozen carrier: 70485fc8eafece770cf57c2f3022cd469adf3ff1.
// Keep CreateSessionPage -> Thread -> CreateTarget -> PhoneThinkingOptions real.
// Account/device/catalog and the submission transport are controlled boundaries.
// Submission is deliberately rejected at that boundary: no real host, model,
// upload, native acceptance or provider acknowledgement is simulated as success.
const fixture = vi.hoisted(() => ({
  owner: 'create-FG-owner', supported: true,
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
  fixture.owner = `create-FG-owner-${++sequence}`; fixture.supported = true
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
const sheet = () => document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')
const editor = () => host!.querySelector<HTMLElement>('[contenteditable]')!
const fast = () => sheet()?.querySelector<HTMLButtonElement>('[data-fast-mode-toggle]')
const effort = (id: string) => sheet()?.querySelector<HTMLElement>(`[data-testid="phone-thinking-options"] [data-option-id="${id}"]`)
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
async function settleSheet() {
  await until('real Work popup visible', () => !!sheet() && getComputedStyle(sheet()!).opacity === '1')
  await Promise.all(sheet()!.getAnimations().map(animation => animation.finished))
}
async function openWork() {
  editor().blur()
  await page.getByTestId('agent-watch-create-model-device').click()
  await until('actual advertised thinking choices', () => !!effort('medium'))
  await settleSheet()
}
async function closeWork() {
  await page.getByTestId('agent-watch-create-controls-sheet-close').click()
  await until('Work actually closed', () => sheet() === null)
}
async function capture(name: string) {
  expect(document.body.textContent).not.toContain('agentWatch.')
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/${name}.png` })
}
function assertAdvertisedTextChoices() {
  expect(sheet()!.querySelector('input[type="range"]')).toBeNull()
  const radios = Array.from(sheet()!.querySelectorAll('[data-testid="phone-thinking-options"] [role="radio"]'))
  expect(radios.map(node => node.getAttribute('data-option-id'))).toEqual(['low', 'medium', 'high'])
  expect(radios.map(node => node.textContent)).toEqual([
    translateSessionMessage('taskConfig.effortLow'), translateSessionMessage('taskConfig.effortMedium'), translateSessionMessage('taskConfig.effortHigh'),
  ])
}
async function submitAtControlledBoundary(expected: { model: string; effort: string; fastMode?: boolean }) {
  await closeWork()
  const prompt = '仅用于隔离载荷验收'
  await page.getByTestId('chat-composer').fill(prompt)
  await until('actual send control enabled', () => host?.querySelector<HTMLButtonElement>('[data-phone-send]')?.disabled === false)
  await page.elementLocator(host!.querySelector<HTMLElement>('[data-phone-send]')!).click()
  await until('page submits to controlled RPC boundary', () => fixture.create.mock.calls.length === 1)
  const [deviceId, request] = fixture.create.mock.calls[0]!
  expect(deviceId).toBe(fixture.device.device_id)
  expect(request).toMatchObject({ harness: 'codex', model: expected.model, effort: expected.effort, prompt })
  if (expected.fastMode === undefined) expect(request).not.toHaveProperty('fastMode')
  else expect(request.fastMode).toBe(expected.fastMode)
  expect(request.initialMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  await until('controlled rejection restores original draft', () => !!host?.querySelector('[role="alert"]') && editor().textContent === prompt)
  expect(fixture.created).not.toHaveBeenCalled()
  expect(fixture.create).toHaveBeenCalledTimes(1)
}
for (const width of [320, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: real creation Work preserves text IDs and Fast on/off across close/reopen, then sends the selected payload`, async () => {
    await mount(width, theme); await openWork(); assertAdvertisedTextChoices()
    expect(effort('medium')!.getAttribute('aria-checked')).toBe('true')
    await until('target-bound Fast is available', () => !!fast())
    expect(fast()!.getAttribute('aria-pressed')).toBe('false')
    await capture(`G-new-fast-off-${width}-${theme}`)
    await page.elementLocator(fast()!).click()
    await until('Fast draft enabled', () => fast()?.getAttribute('aria-pressed') === 'true')
    await page.elementLocator(effort('high')!).click()
    await until('original high ID selected', () => effort('high')?.getAttribute('aria-checked') === 'true')
    await capture(`F-new-thinking-high-${width}-${theme}`)
    await capture(`G-new-fast-on-${width}-${theme}`)
    await closeWork(); await openWork()
    expect(effort('high')!.getAttribute('aria-checked')).toBe('true')
    expect(fast()!.getAttribute('aria-pressed')).toBe('true')
    await page.elementLocator(fast()!).click()
    await until('Fast draft disabled again', () => fast()?.getAttribute('aria-pressed') === 'false')
    await capture(`G-new-fast-off-again-${width}-${theme}`)
    await page.elementLocator(fast()!).click()
    await until('Fast draft re-enabled', () => fast()?.getAttribute('aria-pressed') === 'true')
    await submitAtControlledBoundary({ model: 'native:sol', effort: 'high', fastMode: true })
  })
}
it('creation switches the original model alias, clears Fast, and does not revive it when the native target returns', async () => {
  await mount(390, 'dark'); await openWork()
  await until('target-bound Fast available', () => !!fast())
  await page.elementLocator(fast()!).click()
  await until('Fast draft enabled before model switch', () => fast()?.getAttribute('aria-pressed') === 'true')
  const chooseModel = async (id: string) => {
    await page.elementLocator(sheet()!.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
    await page.elementLocator(sheet()!.querySelector<HTMLElement>(`[data-dimension="model"][data-option-id="${id}"]`)!).click()
    await until('original ID used for new catalog', () => fixture.models.mock.calls.at(-1)?.[3] === id && !!effort('medium'))
  }
  await chooseModel('sonnet')
  await until('other model cannot retain Fast', () => !fast())
  await capture('G-new-model-alias-no-fast-390-dark')
  await chooseModel('native:sol')
  await until('original target has a fresh OFF draft', () => fast()?.getAttribute('aria-pressed') === 'false')
  await capture('G-new-model-reset-fast-off-390-dark')
  await submitAtControlledBoundary({ model: 'native:sol', effort: 'medium', fastMode: false })
})
it('a new task without Fast capability retains only real text levels and omits Fast from the actual submission', async () => {
  fixture.supported = false
  await mount(390, 'dark'); await openWork(); assertAdvertisedTextChoices()
  expect(fast()).toBeNull()
  await capture('G-new-fast-unavailable-390-dark')
  await submitAtControlledBoundary({ model: 'native:sol', effort: 'medium' })
})
