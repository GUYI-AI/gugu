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
import { MarketDetailDialog } from './market-detail-dialog';
import { MarketAgentDetail } from './market-detail-agent';

const f = vi.hoisted(() => ({ install: vi.fn() }));
const codex = { id: 'codex', name: 'Codex', status: 'missing', reading: 'not-detected', command: 'codex',
  installOptions: [{ method: 'mise', command: 'mise install http:gugu-codex', target: { kind: 'mise' } }],
  capabilities: { hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } } },
} as unknown as AgentPayload;

// Only transport replies are fixtures; the dialog, InstallSection and the install store are real.
vi.mock('@renderer/lib/ipc', async original => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const agents = {
    listManagement: async () => [codex],
    getManagement: async () => codex,
    listAgentInstallationStatus: async () => [{ id: 'codex', status: 'missing', reading: 'not-detected', used: { kind: 'auto' }, installations: [] } as unknown as AgentInstallationStatus],
    getInstallSourceVersions: async () => ({ sources: [] }),
    install: f.install,
  };
  return { ...actual, rpc: { ...actual.rpc, agents }, rpcOn: () => ({ agents }), events: { on: () => () => {} } };
});
vi.mock('./market-detail-agent-devices', () => ({ MarketAgentDevices: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queryClient.clear();
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
    <MarketDetailDialog onClose={() => {}}><MarketAgentDetail agentId='codex' onCreate={() => {}} /></MarketDetailDialog>
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
