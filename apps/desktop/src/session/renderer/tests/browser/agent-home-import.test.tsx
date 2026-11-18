import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer'
import { ensureAgentHomeImported } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { showAgentHomeUpgradeNotice } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { FirstRunImport } from '@/components/firstRun/FirstRunImport'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const calls = vi.hoisted(() => ({
  importHome: vi.fn(async () => ({ success: true, data: { issues: [] } })),
  scanHomes: vi.fn(),
  connect: vi.fn(),
  notice: vi.fn(),
}))
vi.mock('@/lib/notices', async (load) => ({
  ...await load<typeof import('@/lib/notices')>(), notify: calls.notice,
}))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async (machine: string | null) => {
    calls.connect(machine)
    return { importAgentHome: calls.importHome, scanAgentHomes: calls.scanHomes }
  },
}))
vi.mock('@renderer/lib/components/app-icon', () => ({ AppIcon: () => null }))
const home: AgentHomeScan = {
  providerId: 'claude', name: 'Claude Code', userRoot: '/fixture/.claude', sourceReadable: true,
  importedAt: null, needsImport: true, sourceUpdated: false, migration: false,
  groups: [{ id: 'settings', count: 1 }, { id: 'hooks', count: 2 }, { id: 'mcp', count: 3 }],
  issues: [], mcpSecrets: [], projectMcpCount: 0,
}
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); vi.clearAllMocks() })

it('shows metadata counts, leaves hooks unticked and imports exactly the chosen groups', async () => {
  harness = createReactHarness()
  const done = vi.fn()
  await harness.render(<FirstRunImport homes={[home]} onDone={done} />)
  expect(harness.container.querySelector<HTMLInputElement>('[data-testid="agent-home-group-claude-hooks"]')!.checked).toBe(false)
  expect(harness.container.querySelector('[data-testid="agent-home-card-claude"]')!.textContent).toContain('/fixture/.claude')
  await clickElement(harness.container.querySelector('[data-testid="first-run-import-continue"]')!)
  await expect.poll(() => calls.importHome.mock.calls.length).toBe(1)
  expect(calls.importHome).toHaveBeenCalledWith({ providerId: 'claude', groups: ['settings', 'mcp'] })
  await expect.poll(() => done.mock.calls.length).toBe(1)
})

it('skip still makes an explicit empty import and continues only after it completes', async () => {
  await page.viewport(1280, 900)
  harness = createReactHarness()
  const done = vi.fn()
  await harness.render(<FirstRunImport homes={[home]} onDone={done} />)
  await clickElement(harness.container.querySelector('[data-testid="first-run-import-skip"]')!)
  await expect.poll(() => done.mock.calls.length).toBe(1)
  expect(calls.importHome).toHaveBeenCalledWith({ providerId: 'claude', groups: [], skip: true })
})


it('waits on the remote first-use card even when the remote has no readable user configuration', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, sourceReadable: false }] })
  harness = createReactHarness()
  await harness.render(<ModalRenderer />)
  const start = vi.fn()
  const launching = ensureAgentHomeImported('claude', 'remote-headless').then(start)
  await expect.poll(() => Boolean(document.querySelector('[data-testid="agent-home-card-claude"]'))).toBe(true)
  expect(start).not.toHaveBeenCalled()
  expect(calls.connect).toHaveBeenCalledWith('remote-headless')
  expect(calls.scanHomes).toHaveBeenCalledWith({ providerIds: ['claude'] })
  await clickElement(document.querySelector('[data-testid="first-run-import-skip"]')!)
  await launching
  expect(calls.importHome).toHaveBeenCalledWith({ providerId: 'claude', groups: [], skip: true })
  expect(start).toHaveBeenCalledTimes(1)
})

it('warns once per upgraded provider and device when OAuth was carried over', () => {
  const upgraded: AgentHomeScan = { ...home, upgraded: true, needsImport: false, upgradeSignIn: 'copied',
    importedAt: new Date().toISOString() }
  showAgentHomeUpgradeNotice(upgraded, 'remote-upgrade')
  showAgentHomeUpgradeNotice(upgraded, 'remote-upgrade')
  expect(calls.notice).toHaveBeenCalledTimes(1)
  expect(calls.notice).toHaveBeenCalledWith(expect.objectContaining({
    description: expect.stringMatching(/same account in your terminal|终端里也用同一个账号/),
    action: expect.objectContaining({ onClick: expect.any(Function) }),
  }))
})
