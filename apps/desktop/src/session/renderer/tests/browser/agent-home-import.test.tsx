import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { agentConfigImportHomes, openAgentHomeImport } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { readAgentHomeUpgradeResults, showAgentHomeUpgradeNotice } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomePreparationStatus } from '@/components/settings/data-import/AgentHomePreparationStatus'
import { AgentHomeSkippedFiles } from '@/components/settings/data-import/AgentHomeSkippedFiles'
import { QwenConfigImport } from '@/components/settings/data-import/QwenConfigImport'
import { AgentConfigImport } from '@/components/settings/data-import/AgentConfigImport'
import { firstInstallImportHomes, showFirstInstallImportNotice, watchFirstInstallImportNotices } from '@renderer/features/settings/subscriptions/first-install-import-notice'
import { Sheet } from '@/components/ui/Sheet'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import { UI_EVENTS } from '@/lib/uiEvents'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const calls = vi.hoisted(() => ({ scanHomes: vi.fn(), importHome: vi.fn(), diffHome: vi.fn(), reimportHome: vi.fn(), notice: vi.fn(), dismiss: vi.fn(), machines: [] as (string | null)[], links: new Map<string, () => void>(), linkState: new Map<string, string>(), each: null as null | ((machine: string) => () => void), remoteIcons: [] as string[] }))
vi.mock('@/lib/notices', async (load) => ({ ...await load<typeof import('@/lib/notices')>(), notify: calls.notice, dismissNotice: calls.dismiss }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async (machine: string | null = null) => { calls.machines.push(machine); return ({
    scanAgentHomes: calls.scanHomes, importAgentHome: calls.importHome, diffAgentHome: calls.diffHome, reimportAgentHome: calls.reimportHome,
  }); },
}))
// The provider ids come from this computer's icon table; another machine's (every icon, read over its link) is not asked.
vi.mock('@renderer/lib/ipc', async original => ({ ...await original<typeof import('@renderer/lib/ipc')>(),
  rpc: { agents: { listIcons: async () => ({ codex: {}, qwen: {} }) } },
  rpcOn: (machine: string | null) => ({ agents: { listIcons: async () => { calls.remoteIcons.push(String(machine)); return { codex: {}, qwen: {} } } } }),
}))
vi.mock('@renderer/lib/machine-clients', async original => ({ ...await original<typeof import('@renderer/lib/machine-clients')>(),
  machineLabel: (machine: string) => machine,
  machineLinkState: (machine: string) => calls.linkState.get(machine),
  onEachMachine: (setup: (machine: string) => () => void) => { calls.each = setup; return () => { calls.each = null; calls.links.clear() } },
  subscribeMachineLink: (machine: string, check: () => void) => { calls.links.set(machine, check); return () => { calls.links.delete(machine) } },
}))
const home: AgentHomeScan = {
  providerId: 'codex', name: 'Codex', userRoot: '/fixture/.codex', sourceReadable: true,
  importedAt: null, needsImport: true, sourceUpdated: false, migration: false,
  groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0,
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { calls.remoteIcons = []; calls.machines = []; calls.links.clear(); calls.linkState.clear(); settingsDeviceStore.select('local') })
afterEach(() => { expect(calls.remoteIcons).toEqual([]); harness?.cleanup(); settingsDeviceStore.select('local'); vi.clearAllMocks() })

it('lets a person choose Qwen configuration groups and keeps hooks unchecked initially', async () => {
  const qwen = { ...home, providerId: 'qwen', name: 'Qwen Code', groups: [
    { id: 'settings', count: 1 }, { id: 'hooks', count: 1 }, { id: 'skills', count: 2 },
  ] } satisfies AgentHomeScan
  calls.scanHomes.mockResolvedValue({ success: true, data: [qwen] })
  calls.importHome.mockImplementation(async () => {
    calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...qwen, needsImport: false }] })
    return { success: true, data: { issues: [] } }
  })
  calls.diffHome.mockResolvedValue({ success: true, data: { entries: [
    { id: 'hook', path: 'settings.json', group: 'hooks', state: 'userAdded', revision: 'hooks-v2' },
  ], issues: [] } })
  calls.reimportHome.mockResolvedValue({ success: true, data: { issues: [] } })
  harness = createReactHarness()
  await harness.render(<Sheet ariaLabel="Settings" onClose={() => undefined} zIndex="var(--z-settings)">
    <QwenConfigImport />
  </Sheet>)
  const row = () => document.querySelector('[data-testid="qwen-config-import"]')!
  await expect.poll(() => row()?.querySelectorAll('input[type="checkbox"]').length).toBe(3)
  const hooks = row().querySelector<HTMLInputElement>('input[value="hooks"]')!
  expect(hooks.checked).toBe(false)
  await clickElement(hooks)
  await clickElement(row().querySelector<HTMLButtonElement>('button[type="submit"]')!)
  await expect.poll(() => calls.importHome.mock.calls[0]?.[0]).toEqual({
    providerId: 'qwen', groups: ['settings', 'hooks', 'skills'],
  })
  await expect.poll(() => row().querySelector('fieldset')).toBeNull()
  await clickElement(row().querySelector<HTMLButtonElement>('button[type="submit"]')!)
  const dialog = () => document.querySelector('[data-testid="agent-home-reimport-dialog"]')
  await expect.poll(() => dialog()).not.toBeNull()
  expect(dialog()?.closest('[role="dialog"]')?.closest<HTMLElement>('[data-sheet-mobile][style*="z-index"]')?.style.zIndex).toBe('var(--z-settings-modal)')
  const reimportHook = dialog()!.querySelector<HTMLInputElement>('fieldset > label input')!
  expect(reimportHook.checked).toBe(false)
  await clickElement(reimportHook)
  await clickElement(dialog()!.querySelector<HTMLButtonElement>('[data-testid="agent-home-reimport-apply"]')!)
  await expect.poll(() => calls.reimportHome.mock.calls[0]?.[0]).toEqual({
    providerId: 'qwen', decisions: [{ id: 'hook', revision: 'hooks-v2' }],
  })
  await expect.poll(() => dialog()).toBeNull()
})

it('opens the import page on the requested unmarked remote host without copying data', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [home] })
  const open = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, open, { once: true })
  expect(await openAgentHomeImport('codex', 'remote-headless')).toBe(false)
  expect(settingsDeviceStore.selected).toBe('remote-headless')
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'data-import', action: undefined } }))
  expect(calls.machines).toEqual(['remote-headless'])
  expect(calls.importHome).not.toHaveBeenCalled()
})

it('opens the import page for an unmarked local home without copying its data', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [home] })
  const open = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, open, { once: true })
  expect(await openAgentHomeImport('codex', null)).toBe(false)
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'data-import', action: undefined } }))
  expect(calls.importHome).not.toHaveBeenCalled()
  expect(calls.diffHome).not.toHaveBeenCalled()
})

it('offers one persistent first-install prompt and only remembers an explicit action', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [home] })
  const homes = await firstInstallImportHomes.fetch()
  expect(calls.scanHomes).toHaveBeenCalledWith({ firstInstallOnly: true })
  showFirstInstallImportNotice([])
  expect(calls.notice).not.toHaveBeenCalled()
  showFirstInstallImportNotice(homes)
  showFirstInstallImportNotice(homes)
  expect(calls.notice).toHaveBeenCalledTimes(1)
  const [notice] = calls.notice.mock.calls[0]!
  expect(notice).toMatchObject({ ongoing: true })
  expect(notice).not.toHaveProperty('presentation')
  expect(localStorage.getItem(notice.key)).toBeNull()
  expect(calls.importHome).not.toHaveBeenCalled()
  const open = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, open, { once: true })
  notice.action.onClick()
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'data-import', action: undefined } }))
  expect(localStorage.getItem(notice.key)).toBe('1')
  expect(calls.importHome).not.toHaveBeenCalled()
  localStorage.removeItem(notice.key)
})

it('uses the existing explicit group import for Codex without importing on mount', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, groups: [
    { id: 'settings', count: 1 }, { id: 'skills', count: 2 },
  ] }] })
  calls.importHome.mockResolvedValue({ success: true, data: { issues: [] } })
  harness = createReactHarness()
  await harness.render(<AgentConfigImport providerId="codex" />)
  const row = () => harness.container.querySelector('[data-testid="codex-config-import"]')!
  await expect.poll(() => row()?.querySelectorAll('input[type="checkbox"]').length).toBe(2)
  expect(calls.importHome).not.toHaveBeenCalled()
  await clickElement(row().querySelector<HTMLButtonElement>('button[type="submit"]')!)
  await expect.poll(() => calls.importHome.mock.calls[0]?.[0]).toEqual({ providerId: 'codex', groups: ['settings', 'skills'] })
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

it('counts a sign-in that needs to be redone as a skipped migration item', () => {
  showAgentHomeUpgradeNotice([{ ...home, providerId: 'qwen', name: 'Qwen Code', importedAt: 'future-migration',
    needsImport: false, upgraded: true, upgradeSignIn: 'relogin', upgradeIssues: [] }])
  const [notice] = calls.notice.mock.calls[0]!
  expect(notice.action.label).toMatch(/1/)
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

it('reports a deferred space shortfall without persisting away the next-startup notice', async () => {
  const blocked = { ...home, migration: true, migrationSpace: {
    requiredBytes: 4_000_000_000, availableBytes: 1_850_000_000, shortfallBytes: 2_150_000_000,
  } }
  calls.scanHomes.mockResolvedValue({ success: true, data: [blocked] })
  expect(await readAgentHomeUpgradeResults()).toEqual([blocked])
  showAgentHomeUpgradeNotice([blocked])
  const [notice] = calls.notice.mock.calls[0]!
  expect(notice.description).toContain('2.2')
  expect(notice.description).toMatch(/space|空间/)
  expect(localStorage.getItem(notice.key)).toBeNull()
})

it('groups skipped library links by skill and reveals paths only in the expanded skill', async () => {
  const issues: AgentHomeScan['issues'] = [
    { path: 'skills/movie/.venv/bin/python', reason: 'symlink' },
    { path: 'skills/movie/node_modules/.bin/tool', reason: 'symlink' },
    { path: 'skills/theme/tokens/file.json', reason: 'unreadable' },
  ]
  harness = createReactHarness()
  await harness.render(<AgentHomeSkippedFiles issues={issues} />)
  const summaries = harness.container.querySelectorAll('summary')
  expect(summaries.length).toBe(2)
  expect(summaries[0]!.textContent).toMatch(/movie.*2/)
  expect(harness.container.textContent).not.toContain('.venv/bin/python')
  await clickElement(summaries[0]!)
  await expect.poll(() => harness.container.querySelectorAll('li').length).toBe(2)
  expect(harness.container.textContent).toContain('.venv/bin/python')
  expect(harness.container.textContent).not.toContain('tokens/file.json')
  expect(harness.container.textContent).not.toContain('·')
})


it('keeps a native preparation reading visible without announcing a completed migration', async () => {
  const preparing = { ...home, migration: true, migrationPreparation: { phase: 'history' as const, startedAt: Date.now() - 2000, attempt: 2 } }
  calls.scanHomes.mockResolvedValue({ success: true, data: [preparing] })
  expect(await readAgentHomeUpgradeResults()).toEqual([preparing])
  showAgentHomeUpgradeNotice([preparing])
  expect(calls.notice).not.toHaveBeenCalled()
  harness = createReactHarness()
  await harness.render(<AgentHomePreparationStatus preparation={preparing.migrationPreparation} />)
  expect(harness.container.textContent).toMatch(/Preparing history|正在整理历史/)
  expect(harness.container.textContent).toMatch(/2/)
  expect(harness.container.textContent).not.toContain('%')
  expect(harness.container.textContent).not.toContain('·')
})

it('folds quota-excluded sessions and says their originals remain in place', async () => {
  harness = createReactHarness()
  await harness.render(<AgentHomeSkippedFiles issues={[
    { path: 'sessions/old-a.jsonl', reason: 'historyLimit' },
    { path: 'sessions/old-b.jsonl', reason: 'historyLimit' },
  ]} />)
  const summary = harness.container.querySelector('summary')!
  expect(summary.textContent).toMatch(/2/)
  expect(summary.textContent).toMatch(/originals are unchanged|原处/)
  expect(harness.container.textContent).not.toContain('old-a.jsonl')
  await clickElement(summary)
  await expect.poll(() => harness.container.querySelectorAll('li').length).toBe(2)
  expect(harness.container.textContent).toContain('old-a.jsonl')
})

it('keeps first import, refresh, diff and reimport on the remote machine', async () => {
  const source = { ...home, groups: [{ id: 'settings', count: 1 }] }
  calls.scanHomes.mockResolvedValue({ success: true, data: [source] })
  calls.importHome.mockImplementation(async () => {
    calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...source, needsImport: false, importedAt: 'fixture' }] })
    return { success: true, data: { issues: [] } }
  })
  calls.diffHome.mockResolvedValue({ success: true, data: { entries: [
    { id: 'config', path: 'config.toml', group: 'settings', state: 'userChanged', revision: 'source-v2' },
  ], issues: [] } })
  calls.reimportHome.mockResolvedValue({ success: true, data: { issues: [] } })
  harness = createReactHarness()
  await harness.render(<Sheet ariaLabel="Settings" onClose={() => undefined} zIndex="var(--z-settings)"><AgentConfigImport providerId="codex" machine="remote-repeat" /></Sheet>)
  const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await expect.poll(() => submit()).not.toBeNull()
  expect(calls.importHome).not.toHaveBeenCalled()
  await clickElement(submit())
  await expect.poll(() => calls.importHome.mock.calls.length).toBe(1)
  await expect.poll(() => document.querySelector('fieldset')).toBeNull()
  await clickElement(submit())
  await expect.poll(() => document.querySelector('[data-testid="agent-home-reimport-apply"]')).not.toBeNull()
  await clickElement(document.querySelector<HTMLButtonElement>('[data-testid="agent-home-reimport-apply"]')!)
  await expect.poll(() => calls.reimportHome.mock.calls.length).toBe(1)
  expect(calls.reimportHome).toHaveBeenCalledWith({ providerId: 'codex', decisions: [{ id: 'config', revision: 'source-v2' }] })
  expect(calls.machines.length).toBeGreaterThanOrEqual(5)
  expect(calls.machines.every(machine => machine === 'remote-repeat')).toBe(true)
})

it('keeps previously imported configurations in the import inventory without depending on CLI availability', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, needsImport: false, importedAt: 'fixture' }] })
  expect(await agentConfigImportHomes.fetch('remote-inventory')).toMatchObject([{ providerId: 'codex', needsImport: false }])
  expect(calls.scanHomes).toHaveBeenCalledWith({ providerIds: ['codex', 'qwen'] })
  expect(calls.machines).toEqual(['remote-inventory'])
})

it('deduplicates the existing prompt by account and machine and routes its action to that machine', () => {
  showFirstInstallImportNotice([home], 'notice-a', 'account-a')
  showFirstInstallImportNotice([home], 'notice-a', 'account-a')
  showFirstInstallImportNotice([home], 'notice-b', 'account-a')
  showFirstInstallImportNotice([home], 'notice-a', 'account-b')
  expect(calls.notice).toHaveBeenCalledTimes(3)
  const notice = calls.notice.mock.calls[0]![0]
  expect(notice.description).toContain('notice-a')
  notice.action.onClick()
  expect(settingsDeviceStore.selected).toBe('notice-a')
  expect(calls.importHome).not.toHaveBeenCalled()
  localStorage.removeItem(notice.key)
})

it('uses connected-machine discovery for the existing prompt and stops publishing after unmount', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, groups: [{ id: 'settings', count: 1 }] }] })
  const stop = watchFirstInstallImportNotices('watch-account')
  calls.linkState.set('remote-watch', 'closed')
  calls.each!('remote-watch')
  expect(calls.machines).not.toContain('remote-watch')
  calls.linkState.set('remote-watch', 'open'); calls.links.get('remote-watch')!()
  await expect.poll(() => calls.notice.mock.calls.some(([notice]) => notice.key.endsWith(':remote-watch'))).toBe(true)
  const count = calls.notice.mock.calls.length
  stop()
  expect(calls.links.size).toBe(0)
  expect(calls.notice.mock.calls.length).toBe(count)
  expect(calls.importHome).not.toHaveBeenCalled()
})

it('resets explicit configuration choices when the target machine changes', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, groups: [{ id: 'settings', count: 1 }, { id: 'skills', count: 1 }] }] })
  harness = createReactHarness()
  await harness.render(<AgentConfigImport providerId="codex" machine="form-a" />)
  const skills = () => harness.container.querySelector<HTMLInputElement>('input[value="skills"]')!
  await expect.poll(() => skills()).not.toBeNull()
  await clickElement(skills())
  expect(skills().checked).toBe(false)
  await harness.render(<AgentConfigImport providerId="codex" machine="form-b" />)
  await expect.poll(() => skills()?.checked).toBe(true)
  expect(calls.machines).toEqual(['form-a', 'form-b'])
  expect(calls.importHome).not.toHaveBeenCalled()
})

// Sign-out returns to the login page in place: the account's import suggestion leaves with it, and comes back on its next
// sign-in (it was not handled), as it would after a restart.
it('withdraws the account\'s notice when its watch stops, and shows it again on the next sign-in', async () => {
  calls.scanHomes.mockResolvedValue({ success: true, data: [{ ...home, groups: [{ id: 'settings', count: 1 }] }] })
  const key = 'gugu.firstInstallImport.v1:leaving-account:local'
  const stop = watchFirstInstallImportNotices('leaving-account')
  await expect.poll(() => calls.notice.mock.calls.filter(([notice]) => notice.key === key).length).toBe(1)
  stop()
  expect(calls.dismiss).toHaveBeenCalledWith(key)

  const again = watchFirstInstallImportNotices('leaving-account')
  await expect.poll(() => calls.notice.mock.calls.filter(([notice]) => notice.key === key).length).toBe(2)
  again()
})

it('does not publish a remote discovery response after its account watcher is disposed', async () => {
  let release!: (result: unknown) => void
  calls.scanHomes.mockResolvedValueOnce({ success: true, data: [] }).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const stop = watchFirstInstallImportNotices('late-account')
  await expect.poll(() => calls.scanHomes.mock.calls.length).toBe(1)
  calls.linkState.set('late-machine', 'open'); calls.each!('late-machine')
  await expect.poll(() => calls.machines.includes('late-machine')).toBe(true)
  stop()
  release({ success: true, data: [{ ...home, groups: [{ id: 'settings', count: 1 }] }] })
  await firstInstallImportHomes.fetch('late-machine')
  expect(calls.notice).not.toHaveBeenCalled()
})
