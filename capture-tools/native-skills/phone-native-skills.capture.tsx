import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, inject, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ThemeProvider, useTheme } from '@/store/theme'
import { readThemePreference, writeThemePreference } from '@renderer/lib/theme/host-theme'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { until } from '../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/mobile/agent-watch/agent-watch.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Account/device/create/model boundaries are controlled. Skills themselves are read from
// real private SKILL.md files by the production scanner in the Node setup server.
const fixture = vi.hoisted(() => ({
  device: { device_id: 'isolated-native-skills', label: 'Isolated MBP fixture', hostname: 'fixture', platform: 'darwin', status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } },
  base: '', reads: [] as { deviceId: string; harness: string; projectId?: string }[],
  create: vi.fn(() => { throw new Error('Agent/model submission is forbidden in this capture') }),
}))
vi.mock('@/store/auth', async original => ({ ...(await original<typeof import('@/store/auth')>()), useAuth: () => ({ user: { id: 'native-skills-capture-owner' } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => fixture.device.label, isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { code = 'capture' },
  machineRpc: (deviceId: string) => ({ sessionTimeline: { sessionCreateSkills: async (input: { harness: string; projectId?: string }) => {
    fixture.reads.push({ deviceId, ...input })
    const query = new URLSearchParams({ harness: input.harness, ...(input.projectId ? { projectId: input.projectId } : {}) })
    const response = await fetch(`${fixture.base}/skills?${query}`)
    if (!response.ok) throw new Error(`Isolated scanner transport refused: ${response.status}`)
    return response.json()
  } } }),
  fetchCreateOptions: async () => ({ projects: [], lastUsed: null, harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
  fetchCreateModels: async () => ({ harness: 'codex', transport: 'acp', selected: null, selectedEffort: null, harnessState: 'ready', harnessReason: null, guguReason: null, harnessAuth: 'signed-in', selectedCredential: 'credentialed', efforts: [], models: [] }),
  createSession: fixture.create, createPhoneSession: fixture.create, fetchPhoneCreateOptions: vi.fn(), fetchPhoneCreateModels: vi.fn(),
}))
let root: Root | null = null, host: HTMLDivElement | null = null
let previousTheme = readThemePreference()
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; fixture.create.mockClear(); writeThemePreference(previousTheme); document.documentElement.removeAttribute('data-theme') })
export function CapturePage() {
  const { theme } = useTheme()
  return <PhoneViewportShell mobile data-phone-shell="" data-ta-scope="" data-capture-shell-theme={theme}
    style={{ display: 'flex', width: '100vw', position: 'fixed', left: 0, overflow: 'hidden', background: 'var(--ta-panel-bg)', paddingTop: 'env(safe-area-inset-top)' }}>
    <SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
      <CreateSessionPage onCreated={fixture.create} />
    </MessageProvider></SessionUiTheme>
  </PhoneViewportShell>
}
async function scenario(mode: 'ready' | 'malformed') {
  fixture.base = inject('nativeSkillsBase')
  const response = await fetch(`${fixture.base}/scenario?mode=${mode}`)
  expect(response.ok).toBe(true)
}
async function mount(theme: 'light' | 'dark') {
  await page.viewport(390, 844)
  previousTheme = readThemePreference()
  setLocalePreference('zh-CN'); writeThemePreference(theme)
  followRendererSession('SIGNED_IN', `native-skills-capture-owner-${theme}-${crypto.randomUUID()}`)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column'
  root = createRoot(host)
  root.render(<ThemeProvider><LocalizationProvider><CapturePage /></LocalizationProvider></ThemeProvider>)
  await until('real creation editor', () => !!host?.querySelector('[contenteditable]'))
  await until('shell theme context and document agree', () => document.documentElement.dataset.theme === theme && host?.querySelector<HTMLElement>('[data-capture-shell-theme]')?.dataset.captureShellTheme === theme)
  const surface = host!.querySelector<HTMLElement>('[data-capture-shell-theme]')!
  const background = getComputedStyle(surface).backgroundColor
  expect(background).not.toBe('rgba(0, 0, 0, 0)')
  if (theme === 'dark') expect(background).not.toBe('rgb(255, 255, 255)')
  expect(host!.textContent).not.toMatch(/agentWatch\.|mobileTaskFlow\.|mobileCreateControls\.|shell\./)
  ;(host!.querySelector('[contenteditable]') as HTMLElement).blur()
  await page.getByTestId('agent-watch-create-skills').click()
}
async function capture(name: string) {
  const panel = document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')!
  await Promise.all(panel.getAnimations().map(animation => animation.finished))
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/${name}.png` })
}
it.each(['light', 'dark'] as const)('%s: actual New Agent page reads real files and searches without creating an agent', async theme => {
  await scenario('ready'); fixture.reads.length = 0; await mount(theme)
  await expect.element(page.getByRole('checkbox', { name: /会议记录/ })).toBeVisible()
  await expect.element(page.getByRole('checkbox', { name: /代码检查/ })).toBeVisible()
  expect(fixture.reads).toContainEqual({ deviceId: fixture.device.device_id, harness: 'codex' })
  await capture(`C-new-read-${theme}-390`)
  await page.getByRole('searchbox', { name: '搜索技能' }).fill('代码')
  await until('real catalog filtered', () => document.querySelectorAll('[data-testid="agent-watch-create-skill"]').length === 1)
  await expect.element(page.getByRole('checkbox', { name: /代码检查/ })).toBeVisible()
  expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!.textContent).not.toContain('整理会议记录与待办事项')
  await capture(`C-new-search-${theme}-390`)
  await page.getByRole('searchbox', { name: '搜索技能' }).fill('不存在的技能')
  await until('no matching skill rows', () => document.querySelectorAll('[data-testid="agent-watch-create-skill"]').length === 0)
  expect(document.querySelectorAll('[data-testid="agent-watch-create-skill"]').length).toBe(0)
  await capture(`C-new-no-match-${theme}-390`)
  expect(fixture.create).not.toHaveBeenCalled()
})
it('malformed real file stays a failure; same-context retry recovers after only that private file is repaired', async () => {
  await scenario('malformed'); fixture.reads.length = 0; await mount('dark')
  await expect.element(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  expect(document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!.textContent).not.toContain('没有可用的技能')
  await capture('C-new-real-read-failure-dark-390')
  await scenario('ready'); await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect.element(page.getByRole('checkbox', { name: /代码检查/ })).toBeVisible()
  expect(fixture.reads.length).toBeGreaterThanOrEqual(2)
  expect(fixture.reads.every(read => read.deviceId === fixture.device.device_id && read.harness === 'codex' && read.projectId === undefined)).toBe(true)
  await capture('C-new-real-retry-dark-390')
  expect(fixture.create).not.toHaveBeenCalled()
})
