import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Only external device/account/RPC boundaries are fixtures. Keep the actual
// CreateSessionPage -> Thread -> CreateTarget -> portalled ModelChoices path.
const fixture = vi.hoisted(() => ({
  device: { device_id: 'model-copy-device', label: 'Test device', hostname: 'fixture', platform: 'linux', status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } },
  models: vi.fn(), create: vi.fn(() => { throw new Error('Creation is outside this display test') }),
}))
vi.mock('@/store/auth', async original => ({ ...(await original<typeof import('@/store/auth')>()), useAuth: () => ({ user: { id: 'model-copy-owner' } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => 'Test device', isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { code = 'fixture' },
  machineRpc: () => { throw new Error('Skills RPC is outside this model display test') },
  fetchCreateOptions: async () => ({ projects: [], lastUsed: { projectId: 'model-copy-workspace', harness: 'codex', sessionView: 'general', permissionMode: null, model: 'native:sol', effort: null }, harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
  fetchCreateModels: fixture.models, createSession: fixture.create,
  fetchPhoneCreateOptions: vi.fn(), fetchPhoneCreateModels: vi.fn(), createPhoneSession: fixture.create,
}))
let root: Root | null = null, host: HTMLDivElement | null = null
const name = 'GPT-6.1-Sol', description = 'Latest workhorse model for coding and everyday work.'
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; document.documentElement.removeAttribute('data-theme'); fixture.create.mockClear() })

it.each(['light', 'dark'] as const)('%s: real New task Work panel separates model copy and preserves native IDs', async theme => {
  fixture.models.mockReset()
  fixture.models.mockImplementation(async (_device: string, _harness: string, _leg: unknown, selected: string | null) => ({
    harness: 'codex', transport: 'acp', selected: selected ?? 'native:sol', selectedEffort: null,
    harnessState: 'ready', harnessReason: null, guguReason: null, harnessAuth: 'signed-in', selectedCredential: 'credentialed', efforts: [],
    models: [{ id: 'native:sol', name, description, source: 'harness' }, { id: 'sonnet', name: 'Unchanged alias', description: 'A deliberately long unbroken description: ' + 'a'.repeat(100), source: 'harness' }],
  }))
  await page.viewport(320, 640)
  setLocalePreference('zh-CN'); writeThemePreference(theme)
  followRendererSession('SIGNED_IN', 'model-copy-owner')
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''; host.dataset.taScope = ''
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ta-panel-bg)'
  root = createRoot(host)
  root.render(<ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}><CreateSessionPage onCreated={vi.fn()} /></MessageProvider></SessionUiTheme></LocalizationProvider></ThemeProvider>)
  await until('real thread editor', () => !!host?.querySelector('[contenteditable]'))
  expect(host!.textContent).toContain('新建任务')
  expect(host!.querySelector('[contenteditable]')?.getAttribute('aria-label')).toBe('第一句话…')
  expect(host!.textContent).not.toContain('agentWatch.')
  await until('production shell theme applied', () => document.documentElement.dataset.theme === theme)
  await document.fonts.ready
  await expect.element(page.getByRole('heading', { name: '新建任务', exact: true })).toBeVisible()
  expect(getComputedStyle(host!).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/B-new-task-page-${theme}-320.png` })
  await page.getByTestId('agent-watch-create-model-device').click()
  await page.elementLocator(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
  const row = () => document.querySelector<HTMLElement>('[data-dimension="model"][data-option-id="native:sol"]')!
  await until('catalog row selected', () => row()?.getAttribute('aria-checked') === 'true')
  const label = row().querySelector<HTMLElement>('.gg-aw-choice-label')!, detail = row().querySelector<HTMLElement>('.gg-aw-choice-desc')!
  expect(label.textContent).toBe(name); expect(detail.textContent).toBe(description)
  expect(getComputedStyle(label.parentElement!).flexDirection).toBe('column')
  expect(detail.getBoundingClientRect().top).toBeGreaterThanOrEqual(label.getBoundingClientRect().bottom)
  expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth)
  const alias = document.querySelector<HTMLElement>('[data-dimension="model"][data-option-id="sonnet"]')!
  expect(alias.scrollWidth).toBeLessThanOrEqual(alias.clientWidth)
  expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!.textContent).not.toContain('agentWatch.')
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/B-new-task-model-${theme}-320.png` })
  await page.elementLocator(alias).click()
  await until('original alias reaches catalog request', () => fixture.models.mock.calls.some(call => call[3] === 'sonnet'))
  expect(fixture.create).not.toHaveBeenCalled()
})
