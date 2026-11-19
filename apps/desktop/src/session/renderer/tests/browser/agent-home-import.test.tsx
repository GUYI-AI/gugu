import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer'
import { openAgentHomeImport } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { readAgentHomeUpgradeResults, showAgentHomeUpgradeNotice } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomeSkippedFiles } from '@/components/settings/data-import/AgentHomeSkippedFiles'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { UI_EVENTS } from '@/lib/uiEvents'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const calls = vi.hoisted(() => ({ scanHomes: vi.fn(), notice: vi.fn() }))
vi.mock('@/lib/notices', async (load) => ({ ...await load<typeof import('@/lib/notices')>(), notify: calls.notice }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({ scanAgentHomes: calls.scanHomes }),
}))
const home: AgentHomeScan = {
  providerId: 'codex', name: 'Codex', userRoot: '/fixture/.codex', sourceReadable: true,
  importedAt: null, needsImport: true, sourceUpdated: false, migration: false,
  groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0,
}
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); vi.clearAllMocks() })

it('never opens the removed configuration import dialog on an unmarked remote host', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [home] })
  harness = createReactHarness()
  await harness.render(<ModalRenderer />)
  expect(await openAgentHomeImport('codex', 'remote-headless')).toBe(false)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows one notice with a link to the import page when an actual migration skipped files', () => {
  const upgraded = { ...home, importedAt: new Date().toISOString(), needsImport: false, upgraded: true,
    upgradeIssues: [{ path: 'rules/link', reason: 'symlink' }] } satisfies AgentHomeScan
  const open = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, open, { once: true })
  showAgentHomeUpgradeNotice([upgraded])
  showAgentHomeUpgradeNotice([upgraded])
  expect(calls.notice).toHaveBeenCalledTimes(1)
  const [notice] = calls.notice.mock.calls[0]!
  expect(notice.action.label).toMatch(/1/)
  notice.action.onClick()
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'data-import', action: undefined } }))
})

it('names every migrated managed home and avoids promising sign-ins for unrelated providers', async () => {
  const results = [
    { ...home, providerId: 'kimi', name: 'Kimi' },
    { ...home, providerId: 'antigravity', name: 'Antigravity' },
  ].map((row) => ({ ...row, upgraded: true, needsImport: false, importedAt: new Date().toISOString() }))
  calls.scanHomes.mockResolvedValue({ success: true, data: [home, ...results] })
  showAgentHomeUpgradeNotice(await readAgentHomeUpgradeResults())
  expect(calls.scanHomes).toHaveBeenCalledWith({ upgradedOnly: true })
  const [notice] = calls.notice.mock.calls[0]!
  expect(notice.description).toContain('Kimi')
  expect(notice.description).toContain('Antigravity')
  expect(notice.description).not.toContain('Codex')
  expect(notice.action).toBeUndefined()
})

it('folds long paths in import results while keeping the original reason available', async () => {
  const issues: AgentHomeScan['issues'] = Array.from({ length: 64 }, (_, index) => ({
    path: `archive/fixture/path/file-${index}.jsonl`, reason: 'tooLarge',
  }))
  harness = createReactHarness()
  await harness.render(<AgentHomeSkippedFiles issues={issues} />)
  const summary = harness.container.querySelector('summary')!
  expect(summary.textContent).toMatch(/64.*(?:too large|太大)/)
  expect(harness.container.textContent).not.toContain(issues[0]!.path)
  await clickElement(summary)
  await expect.poll(() => harness.container.querySelectorAll('li').length).toBe(64)
  expect(harness.container.textContent).toContain(issues[0]!.path)
})
