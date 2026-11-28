// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { followRendererSession, queryClient } from '@/lib/replica';
import type { AgentInstallationStatus, AgentPayload } from '@shared/core/agents/agent-payload';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { until } from '../../../../../../../../tests/support/awaitCondition';
import { typeInto } from '../../../../../../../../tests/support/testHarness';
import { toast } from '@renderer/lib/hooks/use-toast';
import { agentSettings } from '@renderer/lib/stores/agent-replicas';
import { AgentAppDetailDialog } from '@renderer/features/apps/agent-app-detail-dialog';

const f = vi.hoisted(() => ({ install: vi.fn(), update: vi.fn(), override: null as AgentPayload | null, installed: false, config: { extraArgs: '--search' } as { extraArgs: string; env?: Record<string, string> } }));
const codex = { id: 'codex', name: 'Codex', status: 'missing', reading: 'not-detected', command: 'codex',
  installOptions: [{ method: 'mise', command: 'mise install http:gugu-codex', target: { kind: 'mise' } }],
  capabilities: { hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } } },
} as unknown as AgentPayload;
const installState = () => f.installed ? { status: 'available', reading: 'installed' } : { status: 'missing', reading: 'not-detected' };
const current = () => f.override ?? ({ ...codex, ...installState() });

// Only transport replies are fixtures; the dialog, InstallSection and the install store are real.
vi.mock('@renderer/lib/ipc', async original => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const agents = {
    listManagement: async () => [current()],
    getManagement: async () => current(),
    list: async () => [current()],
    listIcons: async () => ({}),
    listAgentInstallationStatus: async () => [f.override ?? { id: 'codex', ...installState(), used: { kind: 'auto' }, installations: [] } as unknown as AgentInstallationStatus],
    getSettings: async () => ({ value: f.config, defaults: {}, overrides: {} }),
    getInstallSourceVersions: async () => ({ sources: [] }),
    install: f.install, update: f.update, getManagedVersions: async () => ({ currentVersion: '', versions: [] }),
  };
  return { ...actual, rpc: { ...actual.rpc, agents }, rpcOn: () => ({ agents }), events: { on: () => () => {} } };
});
vi.mock('@renderer/lib/hooks/use-toast', async original => ({ ...await original<typeof import('@renderer/lib/hooks/use-toast')>(), toast: vi.fn() }));
vi.mock('./market-detail-agent-devices', () => ({ MarketAgentDevices: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queryClient.clear();
  f.installed = false;
  f.override = null;
  vi.mocked(toast).mockClear();
  f.config = { extraArgs: '--search' };
  followRendererSession('SIGNED_IN', 'market-agent-fixture');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); queryClient.clear(); followRendererSession('SIGNED_OUT', null); vi.unstubAllGlobals();
});

// A failed install used to drop the dialog back to a bare 'Install' with only a toast, gone before anyone read it.
it('says why the install failed and lets the person retry from the dialog', async () => {
  f.install.mockResolvedValue({ success: false, error: { type: 'command-failed', message: 'Managed installation failed.',
    output: 'error sending request for url (https://registry.npmmirror.com/@openai/codex): connection reset', stage: 'download' } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <AgentAppDetailDialog agentId='codex' onClose={() => {}} onCreate={() => {}} />
  </SessionLocalizationProvider></QueryClientProvider>));
  const install = translateSessionMessage('extensions.installAction');
  const button = () => [...document.querySelectorAll('button')].find(b => b.textContent === install);
  await until('the Install button is offered', () => !!button());
  expect(document.querySelector('[role=alert]')).toBeNull();
  await act(async () => button()!.click());
  await until('the failure is shown in the dialog', () => !!document.querySelector('[role=alert]'));
  const alert = document.querySelector('[role=alert]')!;
  expect(f.install).toHaveBeenCalledExactlyOnceWith('codex', 'mise', undefined);
  expect(alert.textContent).toContain(translateSessionMessage('agentsPage.failureNetwork', { operation: translateSessionMessage('agentsPage.installation') }));
  expect(alert.querySelector('pre')?.textContent).toContain('connection reset');
  const retry = [...document.querySelectorAll('button')].find(b => b.textContent === translateSessionMessage('extensions.retry'));
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  await until('retry runs the same installation', () => f.install.mock.calls.length === 2);
});

// #3287 moved installed agents into this dialog and left 高级 behind: extra arguments and env could no longer be edited.
it('opens 高级设置 in place of the details for an installed agent, and goes back', async () => {
  f.installed = true;
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <AgentAppDetailDialog agentId='codex' onClose={() => {}} onCreate={() => {}} />
  </SessionLocalizationProvider></QueryClientProvider>));
  const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid=agent-advanced-settings]');
  const panel = () => document.querySelector<HTMLElement>('[data-testid=agent-advanced-panel]')!.parentElement!;
  const details = () => panel().previousElementSibling as HTMLElement;
  await until('the 高级设置 button is offered', () => !!toggle());
  expect(toggle()!.textContent).toBe(translateSessionMessage('agentsPage.advancedSettings'));
  expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
  expect(panel().hasAttribute('inert')).toBe(true);
  expect(details().hasAttribute('inert')).toBe(false);

  await act(async () => toggle()!.click());
  expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
  expect(panel().hasAttribute('inert')).toBe(false);
  expect(panel().querySelector('[role=combobox][aria-label="Source"]')).not.toBeNull();
  expect(details().hasAttribute('inert')).toBe(true);
  await until('the stored extra arguments are shown', () => document.querySelector<HTMLInputElement>('#agent-extraArgs')?.value === '--search');

  await act(async () => toggle()!.click());
  expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
  expect(panel().hasAttribute('inert')).toBe(true);
});

it('offers no 高级设置 before the agent is installed', async () => {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <AgentAppDetailDialog agentId='codex' onClose={() => {}} onCreate={() => {}} />
  </SessionLocalizationProvider></QueryClientProvider>));
  await until('the Install button is offered', () => [...document.querySelectorAll('button')].some(b => b.textContent === translateSessionMessage('extensions.installAction')));
  expect(document.querySelector('[data-testid=agent-advanced-settings]')).toBeNull();
  expect(document.querySelector('[data-testid=agent-advanced-panel]')).toBeNull();
});


it('keeps a newer environment edit when the host confirms an earlier save', async () => {
  f.installed = true;
  f.config = { extraArgs: '--search', env: { EXAMPLE: '' } };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <AgentAppDetailDialog agentId='codex' onClose={() => {}} onCreate={() => {}} />
  </SessionLocalizationProvider></QueryClientProvider>));
  const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid=agent-advanced-settings]');
  await until('the settings are available', () => !!toggle());
  await act(async () => toggle()!.click());
  const value = () => document.querySelector<HTMLInputElement>('input[aria-label="value"]');
  await until('the saved variable is shown', () => !!value());
  await typeInto(value()!, 'draft');
  f.config = { extraArgs: '--verbose', env: { EXAMPLE: '' } };
  await act(async () => { await agentSettings.refresh(null, 'codex'); });
  await until('the clean field reflects the host refresh', () => document.querySelector<HTMLInputElement>('#agent-extraArgs')?.value === '--verbose');
  expect(value()!.value).toBe('draft');
});

it.each([true, false])('keeps the update action consistent with the refreshed device after reopening (remaining %s)', async (remaining) => {
  const managed = (version: string): AgentPayload => ({
    ...codex, id: 'claude', name: 'Claude Code', status: 'available', reading: 'installed',
    used: { kind: 'method', method: 'mise' },
    capabilities: { hostDependency: { updates: { kind: 'supported', update: { kind: 'package-manager' } } } },
    installations: [{ id: 'managed', version, latestVersion: '2.1.332', updateAvailable: version !== '2.1.332',
      isActive: true, status: 'available', manageable: true, realpath: '/fixture/claude', provenance: { kind: 'mise', ours: true } }],
  } as unknown as AgentPayload);
  f.override = managed('2.1.278');
  f.update.mockImplementationOnce(async () => {
    f.override = managed(remaining ? '2.1.278' : '2.1.332');
    return { success: true, data: {} };
  });
  const open = () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <AgentAppDetailDialog agentId="claude" onClose={() => {}} onCreate={() => {}} />
  </SessionLocalizationProvider></QueryClientProvider>);
  const button = () => [...document.querySelectorAll('button')].find(b => b.textContent === translateSessionMessage('extensions.updateAction'));
  await act(async () => open());
  await until('the older managed copy offers Update', () => !!button());
  await act(async () => button()!.click());
  const title = remaining ? 'Update still available for Claude Code v2.1.332' : 'Claude Code updated to v2.1.332';
  await until('the receipt describes the refreshed device', () => vi.mocked(toast).mock.calls.some(([message]) => message.title === title));
  expect(!!button()).toBe(remaining);
  await act(async () => root.render(null));
  await act(async () => open());
  await until('the device version is rendered after reopening', () => document.querySelector('[data-testid=market-detail-dialog]')?.textContent?.includes(remaining ? 'v2.1.278' : 'v2.1.332') === true);
  expect(!!button()).toBe(remaining);
});
