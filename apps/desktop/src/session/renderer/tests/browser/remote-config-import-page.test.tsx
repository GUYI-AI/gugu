import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { observable, runInAction } from 'mobx'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { i18n } from '@/i18n'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import type { RemoteHostDevice } from '@/session/shared/remote-hosts'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { SettingsPanel } from '@/components/SettingsPanel'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@/components/settings/settings.css'
import '@renderer/index.css'
// These settings sections never render in the model-page scenarios.
vi.mock('@/components/settings/PasswordSection', () => ({ PasswordSection: () => null }));
vi.mock('@/components/settings/AboutSection', () => ({ AboutSection: () => null }));
vi.mock('@/components/settings/HelpSection', () => ({ HelpSection: () => null }));
vi.mock('@/components/settings/AccountSection', () => ({ AccountSection: () => null }));
vi.mock('@/components/settings/DevicesSection', () => ({ DevicesSection: () => null }));
vi.mock('@/components/settings/FileStorageSection', () => ({ FileStorageSection: () => null }));
vi.mock('@/components/settings/GeneralSection', () => ({ GeneralSection: () => null }));
vi.mock('@/components/usage/UsageSection', () => ({ UsageSection: () => null }));
vi.mock('@/components/settings/PermissionsSection', () => ({ PermissionsSection: () => null }));
vi.mock('@/features/team/TeamSettingsUsage', () => ({ TeamSettingsUsage: () => null }));
vi.mock('@/features/team/TeamPage', () => ({ TeamPage: () => null }));
vi.mock('@/mobile/phone-device/PhoneDeviceActionsPage', () => ({ PhoneDeviceActionsPage: () => null }));

vi.mock('@/components/settings/ModelSection', () => ({ ModelSection: () => null }));

const state = vi.hoisted(() => ({ imports: [] as (string | null)[], diffs: [] as (string | null)[], imported: new Set<string>() }))
vi.mock('@gugu/core/cloud/config', async original => ({ ...await original<object>(), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'fixture' }))
vi.mock('@/platform', async original => { const actual = await original<typeof import('@/platform')>(); return { ...actual, platform: { ...actual.platform, kind: 'electron', capabilities: { ...actual.platform.capabilities, sessionHost: true } } } })
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { hosts: observable.map(), start: vi.fn() } }))
vi.mock('@renderer/lib/ipc', async original => ({ ...await original<typeof import('@renderer/lib/ipc')>(),
  // Provider ids come from this computer's icon table (`agentIcons`), ❌ the machine's.
  rpcOn: () => ({ agents: { listIcons: async () => { throw new Error('another machine\'s icon table is not read') } } }),
  rpc: { appSettings: { getWithMeta: async () => ({ value: { owners: {} }, defaults: { owners: {} }, overrides: {} }) },
    agents: { listIcons: async () => ({ codex: {} }) } },
}))
vi.mock('@/components/settings/data-import/use-external-import-providers', () => ({ useExternalImportProviders: () => ({ providers: [], historyDialog: null }) }))
vi.mock('@/components/settings/data-import/import-providers', () => ({ importProviders: [], locateImportProvider: () => undefined, registerExtraImportProviders: () => () => {} }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async (machine: string | null = null) => ({
  scanAgentHomes: async (input: { upgradedOnly?: boolean }) => ({ success: true, data: input.upgradedOnly ? [] : [home(machine)] }),
  importAgentHome: async () => { state.imports.push(machine); state.imported.add(machine ?? 'local'); return { success: true, data: { issues: [] } } },
  diffAgentHome: async () => { state.diffs.push(machine); return { success: true, data: { entries: [], issues: [] } } },
}) }))
function home(machine: string | null): AgentHomeScan {
  const imported = state.imported.has(machine ?? 'local')
  return { providerId: 'codex', name: 'Codex', userRoot: machine ? '/fixture/remote/.codex' : '/fixture/local/.codex', sourceReadable: true,
    importedAt: imported ? '2026-11-22T00:00:00.000Z' : null, needsImport: !imported, sourceUpdated: false, migration: false,
    groups: [{ id: 'settings', count: 1 }, { id: 'skills', count: 2 }, { id: 'hooks', count: 1 }], issues: [], mcpSecrets: [], projectMcpCount: 0 }
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  state.imports = []; state.diffs = []; state.imported.clear(); settingsDeviceStore.select('local')
  runInAction(() => { remoteHostsStore.hosts.clear(); for (const [id, label] of [['remote-a', '开发机 A'], ['remote-b', '开发机 B']]) {
    const device: RemoteHostDevice = { id, label, isOnline: true, platform: 'linux', lastSeenAt: null, sessionDigest: null, directTerminal: true, hostKind: 'server', connectVia: 'ssh' }
    remoteHostsStore.hosts.set(id, { device, link: 'open', synced: true })
  } })
  await i18n.changeLanguage('zh-CN'); await page.viewport(1280, 900); document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  await renderWithAppProviders(harness, <SettingsPanel initialSection="data-import" onClose={vi.fn()} />, { auth: { id: 'remote-import-3515', nickname: '测试账号', avatarUrl: '' }, contacts: {} })
  await expect.element(page.getByTestId('codex-config-import')).toBeVisible()
})
afterEach(() => { harness?.cleanup(); settingsDeviceStore.select('local') })
async function click(locator: ReturnType<typeof page.getByTestId>) { await act(async () => { await userEvent.click(locator) }) }
async function capture(name: string) {
  if (import.meta.env.VITE_IMPORT_MACHINE_CAPTURE !== '1') return
  await document.fonts.ready
  await page.screenshot({ path: `../../../../../../../test-results/remote-config-import-3515/${name}.png` })
}
it('imports and reopens the diff on A, then switches the same component to B without importing on mount', async () => {
  await capture('local')
  expect(state.imports).toEqual([])
  await click(page.getByRole('tab', { name: '设备', exact: true }))
  await expect.element(page.getByRole('combobox', { name: '设备', exact: true })).toHaveValue('remote-a')
  await expect.element(page.getByTestId('codex-config-import')).toBeVisible()
  await capture('remote-first-import')
  expect(page.getByTestId('codex-config-import').element().querySelector<HTMLInputElement>('input[value="hooks"]')?.checked).toBe(false)
  await click(page.getByTestId('codex-config-import').getByRole('button', { name: '导入', exact: true }))
  await expect.element(page.getByTestId('codex-config-import').getByRole('button', { name: '重新导入', exact: true })).toBeVisible()
  expect(state.imports).toEqual(['remote-a'])
  await capture('remote-imported')
  await click(page.getByTestId('codex-config-import').getByRole('button', { name: '重新导入', exact: true }))
  await expect.element(page.getByTestId('agent-home-reimport-dialog')).toBeVisible()
  expect(state.diffs).toEqual(['remote-a'])
  await click(page.getByRole('button', { name: '取消', exact: true }))
  await act(async () => { await userEvent.selectOptions(page.getByRole('combobox', { name: '设备', exact: true }), 'remote-b') })
  await expect.element(page.getByTestId('codex-config-import').getByRole('button', { name: '导入', exact: true })).toBeVisible()
  expect(settingsDeviceStore.selected).toBe('remote-b')
  expect(state.imports).toEqual(['remote-a'])
})
