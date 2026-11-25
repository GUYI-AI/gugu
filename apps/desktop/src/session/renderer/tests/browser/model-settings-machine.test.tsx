import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { runInAction } from 'mobx';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { SettingsPanel } from '@/components/SettingsPanel';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/components/settings/settings.css';
import '@/styles/tokens.css';
import '@renderer/index.css';


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

const state = vi.hoisted(() => ({ calls: [] as { machine: string | null; action: string; input?: unknown }[],
  delay: null as Promise<void> | null, delayedMachine: '', failMachine: '' }));
vi.mock('@gugu/core/cloud/config', async original => ({ ...await original<object>(), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>();
  return { ...actual, platform: { ...actual.platform, kind: 'electron' } };
});
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', async () => {
  const { observable } = await import('mobx');
  const hosts = observable.map<string, { device: RemoteHostDevice }>();
  return { remoteHostsStore: { hosts, start: vi.fn(), canAddMachine: false,
    device: (id: string) => hosts.get(id)?.device,
    connectionState: (id: string) => hosts.get(id)?.device.isOnline ? 'connected' : 'offline',
    cloudScope: () => null, wakeCloudComputer: vi.fn(),
  } };
});
vi.mock('@renderer/lib/stores/use-agents', async original => ({ ...await original<typeof import('@renderer/lib/stores/use-agents')>(), useAgents: () => ({ data: [] }) }));
vi.mock('@/lib/agentModelReplicas', async () => {
  const { replica } = await import('@/lib/replica');
  return { platformModels: replica({ name: 'model-machine-platform-fixture', scope: 'account', read: async () => [] }) };
});
vi.mock('@renderer/lib/ipc', async original => ({
  ...await original<typeof import('@renderer/lib/ipc')>(), invokeOnMachine: async () => [],
  rpc: { appSettings: { getWithMeta: async (key: string) => {
    const value = key === 'autoReviewModel' ? null : { titleModel: 'gugu-fast' };
    return { value, defaults: value, overrides: {} };
  }, update: vi.fn() } },
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async (machine: string | null = null) => ({
    listCustomModels: async () => {
      state.calls.push({ machine, action: 'list' });
      if (machine === state.delayedMachine && state.delay) await state.delay;
      if (machine === state.failMachine) throw new Error('Fixture machine unavailable');
      return { success: true, data: [record(machine)] };
    },
    detectCustomModelProtocols: async (input: unknown) => { state.calls.push({ machine, action: "detect", input }); return { success: true, data: { endpoints: record(machine).endpoints, models: [record(machine).models[0]!.id], failures: [] } }; },
    testCustomModel: async (input: unknown) => { state.calls.push({ machine, action: 'test', input }); return { success: true, data: { kind: 'connected' } }; },
    saveCustomModel: async (input: SaveCustomModel) => { state.calls.push({ machine, action: 'save', input }); return { success: true, data: { ...record(machine), ...input } }; },
    removeCustomModel: async (input: unknown) => { state.calls.push({ machine, action: 'remove', input }); return { success: true, data: undefined }; },
  }),
}));
function record(machine: string | null): CustomModelConnection {
  return { id: machine ?? 'local', name: machine === 'remote-a' ? '远端 A 模型' : machine === 'remote-b' ? '远端 B 模型' : '本机模型',
    credentialRef: 'fixture', keySaved: true, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }], models: [{ id: machine ?? 'local-model' }] };
}
const device = (id: string, label: string): RemoteHostDevice => ({ id, label, isOnline: true, platform: 'linux', lastSeenAt: null,
  sessionDigest: null, directTerminal: true, hostKind: 'server', connectVia: 'ssh' });
let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  state.calls = []; state.delay = null; state.delayedMachine = ''; state.failMachine = '';
  settingsDeviceStore.select('local');
  runInAction(() => {
    remoteHostsStore.hosts.clear();
    // Only the public device metadata read by the real picker is required by this fixture.
    remoteHostsStore.hosts.set('remote-a', { device: device('remote-a', '开发机 A'), link: 'open', synced: true });
    remoteHostsStore.hosts.set('remote-b', { device: device('remote-b', '开发机 B'), link: 'open', synced: true });
  });
  await page.viewport(1280, 900); await i18n.changeLanguage('zh-CN');
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  await renderWithAppProviders(harness, <SettingsPanel initialSection="model" onClose={vi.fn()} />, { auth: { id: 'model-machine-3517', nickname: '测试账号', avatarUrl: '' }, contacts: {} });
  await until('the real model page has loaded its local connection', () => !!document.querySelector('[data-custom-connection="local"]'));
});
afterEach(() => { harness?.cleanup(); settingsDeviceStore.select('local'); vi.unstubAllGlobals(); });
async function click(locator: ReturnType<typeof page.getByTestId>) { await act(async () => { await userEvent.click(locator); }); }
const heading = () => page.getByTestId('settings-model-machine');
async function choose(label: string) {
  await click(heading().getByTestId('machine-picker'));
  await click(page.getByRole('menuitem', { name: new RegExp(label) }));
}
async function capture(name: string) {
  if (import.meta.env.VITE_MODEL_MACHINE_CAPTURE !== '1') return;
  await document.fonts.ready;
  await page.screenshot({ path: `../../../../../../../test-results/model-machine-3517/${name}.png` });
}
it('uses the existing settings selection for local → A → B → local and captures the actual settings page', async () => {
  await expect.element(heading()).toHaveTextContent('本机'); await capture('local');
  await click(heading().getByTestId('machine-picker')); await expect.element(page.getByRole('menuitem', { name: /开发机 A/ })).toBeVisible(); await capture('menu');
  await click(page.getByRole('menuitem', { name: /开发机 A/ }));
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 A 模型');
  expect(settingsDeviceStore.selected).toBe('remote-a'); await capture('remote-a');
  await choose('开发机 B');
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 B 模型');
  expect(settingsDeviceStore.selected).toBe('remote-b');
  await choose('本机');
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('本机模型');
  expect(settingsDeviceStore.selected).toBe('local');
  expect(state.calls.filter(call => call.action === 'list').map(call => call.machine)).toEqual(expect.arrayContaining([null, 'remote-a', 'remote-b']));
});
it('routes testing, editing and deleting to the selected device and drops an open edit on external scope change', async () => {
  await choose('开发机 A');
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 A 模型');
  await click(page.getByRole('button', { name: '管理模型', exact: true }).nth(1));
  await click(page.getByRole('button', { name: '编辑 remote-a', exact: true }));
  await click(page.getByTestId('custom-model-test'));
  expect(state.calls).toContainEqual({ machine: 'remote-a', action: 'detect', input: { connectionId: 'remote-a', baseUrl: 'https://provider.test/v1', modelId: 'remote-a' } });
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  await act(async () => settingsDeviceStore.select('remote-b'));
  await expect.element(page.getByTestId('custom-model-dialog')).not.toBeInTheDocument();
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 B 模型');
  await click(page.getByRole('button', { name: '删除', exact: true }));
  expect(state.calls).toContainEqual({ machine: 'remote-b', action: 'remove', input: { connectionId: 'remote-b' } });
});
it('keeps an unavailable remote selected instead of silently listing local data', async () => {
  state.failMachine = 'remote-a';
  runInAction(() => { remoteHostsStore.hosts.get('remote-a')!.device.isOnline = false; });
  const localReads = state.calls.filter(call => call.machine === null && call.action === 'list').length;
  await choose('开发机 A');
  await expect.element(heading()).toHaveTextContent('开发机 A');
  await expect.element(heading().getByTestId('device-scope-status')).toHaveTextContent('离线');
  expect(settingsDeviceStore.selected).toBe('remote-a');
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('Fixture machine unavailable');
  expect(state.calls.filter(call => call.machine === null && call.action === 'list')).toHaveLength(localReads);
});
it('does not let a slow reply from A overwrite B after a scope change', async () => {
  let release!: () => void;
  state.delayedMachine = 'remote-a'; state.delay = new Promise(resolve => { release = resolve; });
  try {
    await choose('开发机 A');
    await until('A request is pending', () => state.calls.some(call => call.machine === 'remote-a' && call.action === 'list'));
    await choose('开发机 B');
    await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 B 模型');
  } finally { release(); }
  await customModels.fetch('remote-a');
  await expect.element(page.getByTestId('settings-custom-models')).toHaveTextContent('远端 B 模型');
  expect(document.querySelector('[data-custom-connection="remote-a"]')).toBeNull();
});
