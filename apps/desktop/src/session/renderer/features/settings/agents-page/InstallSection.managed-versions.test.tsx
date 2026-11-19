// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { followRendererSession, queryClient } from '@/lib/replica';
import type { AgentInstallationStatus, AgentPayload, Installation } from '@shared/core/agents/agent-payload';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { InstallSection } from './InstallSection';
import { until } from '../../../../../../../../tests/support/awaitCondition';

const state = vi.hoisted(() => ({
  installations: [] as Installation[],
  active: '',
  readVersions: vi.fn(async () => ({ currentVersion: '1.3.0', versions: ['1.1.0', '1.3.0'] })),
}));
const agent = { id: 'codex', name: 'Codex', command: '/current/codex', status: 'available', reading: 'installed', installOptions: [],
  capabilities: { hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } } },
} as unknown as AgentPayload;

// Only transport replies are fixtures. InstallSection, source resolution, replica and ManagedVersionsRow are real.
vi.mock('@renderer/lib/ipc', async original => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const agents = {
    list: async () => [],
    listAgentInstallationStatus: async () => [{ id: 'codex', status: 'available', reading: 'installed',
      used: { kind: 'pinned', realpath: state.active }, installations: state.installations,
    } as AgentInstallationStatus],
    getManagedVersions: state.readVersions,
  };
  return { ...actual, rpc: { ...actual.rpc, agents }, rpcOn: () => ({ agents }), events: { on: () => () => {} } };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queryClient.clear();
  followRendererSession('SIGNED_IN', 'cleanup-dialog-fixture');
  state.readVersions.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); queryClient.clear(); followRendererSession('SIGNED_OUT', null); vi.unstubAllGlobals();
});

function copy(id: string, kind: Installation['provenance']['kind'], ours: boolean): Installation {
  return { id, realpath: id, pathEntry: id, isActive: id === state.active, manageable: ours,
    provenance: { kind, confidence: 'confirmed', ...(ours ? { ours: true } : {}) }, status: 'available', version: '1.3.0' };
}
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <InstallSection agentId="codex" agentPayload={agent} installOptions={[]} manageOldVersions
      renderPage={installation => <div data-source={installation.source ?? ''} data-version={installation.version}>{installation.managedVersions}</div>} />
  </SessionLocalizationProvider></QueryClientProvider>));
  await until('the authoritative installed copy is resolved', () => host.querySelector('[data-version]')?.getAttribute('data-version') === '1.3.0');
}

it('passes the existing cleanup row for the active managed mise copy, even with another managed copy first', async () => {
  state.active = '/current/codex';
  state.installations = [copy('/other/codex', 'npm', true), copy(state.active, 'mise', true)];
  await mount();
  await until('the real cleanup row reads its version inventory', () => host.textContent?.includes('v1.1.0') === true);
  expect(host.querySelector('[data-testid="managed-old-versions"]')).not.toBeNull();
  expect(state.readVersions).toHaveBeenCalledExactlyOnceWith('codex');
});

it.each(['local', 'custom', 'non-mise'] as const)('does not expose cleanup for an active %s copy', async mode => {
  state.active = mode === 'custom' ? 'path' : '/current/codex';
  state.installations = [copy('/unused/managed', 'mise', true),
    copy(state.active, mode === 'non-mise' ? 'npm' : mode === 'custom' ? 'mise' : 'homebrew', mode !== 'local')];
  await mount();
  expect(host.querySelector('[data-testid="managed-old-versions"]')).toBeNull();
  expect(state.readVersions).not.toHaveBeenCalled();
});
