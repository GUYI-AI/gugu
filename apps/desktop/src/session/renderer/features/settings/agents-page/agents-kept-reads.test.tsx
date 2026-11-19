// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agents page, an agent's detail and its "Advanced" section when a reading read before fails to read again: what was
 * read stays drawn and the failure is said beside it with a retry (❌ shown as current, ❌ nothing said on this computer).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => {
  const failed = <V,>(value: V) => ({ state: 'value' as const, value, stale: false, error: new Error('machine gone') as Error | null });
  const agent = { id: 'claude', name: 'Claude Code', reading: 'installed', installOptions: [], installDocs: null };
  return { failed, agent, list: failed([agent]), detail: failed(agent), settings: { error: new Error('machine gone') as Error | null } };
});
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/lib/commands/use-command-provider', () => ({ useCommandProvider: () => undefined }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { cloudScope: () => null } }));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({ useAgentInstallationStatuses: () => ({ probeAll: vi.fn() }) }));
vi.mock('@renderer/lib/stores/use-agents', () => ({
  useManagementAgents: () => ({ reading: h.list, refetch: vi.fn() }),
  useManagementAgent: () => h.detail,
}));
vi.mock('@renderer/lib/stores/use-agent-settings', () => ({
  useAgentSettings: () => ({ value: { extraArgs: '--fast' }, isOverridden: false, isLoading: false, error: h.settings.error, retry: vi.fn(), update: vi.fn(), reset: vi.fn() }),
}));
vi.mock('./CliAgentsList', () => ({ CliAgentsList: () => React.createElement('ul', { 'data-testid': 'agents-list' }, 'Claude Code') }));
vi.mock('./agent-account', () => ({ agentOffersConnections: () => false }));
vi.mock('./InstallSection', () => ({ InstallSection: () => React.createElement('div', { 'data-testid': 'install-section' }) }));
vi.mock('./AgentModalHeaderSection', () => ({ AgentModalHeaderSection: ({ agent }: { agent: { name: string } }) => React.createElement('h2', null, agent.name) }));
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { Dialog: pass, DialogContent: pass, DialogContentArea: pass, DialogHeader: pass, DialogTitle: pass };
});
vi.mock('@renderer/lib/ui/modal-layout', () => ({ ModalLayout: ({ header, children }: { header: React.ReactNode; children: React.ReactNode }) => React.createElement('div', null, header, children) }));

const { AgentsSettingsPage } = await import('./AgentsSettingsPage');
const { AgentDetailModal } = await import('./AgentDetailModal');
const { AgentAdvancedSection } = await import('./AgentAdvancedSection');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const said = () => host.querySelector('[data-refresh-failed]');

describe('agent readings read before, a re-read that fails', () => {
  it('the agents page on this computer: the list stays, the failure is said', async () => {
    await act(async () => root.render(<AgentsSettingsPage selectedAgentId={null} onSelectAgent={vi.fn()} />));
    expect(host.querySelector('[data-testid="agents-list"]')).not.toBeNull();
    expect(said()).not.toBeNull();
  });

  it('an agent\'s detail: drawn from what was read, the failure said', async () => {
    await act(async () => root.render(<AgentDetailModal agentId="claude" onClose={vi.fn()} />));
    expect(host.textContent).toContain('Claude Code');
    expect(host.querySelector('[data-testid="install-section"]')).not.toBeNull();
    expect(said()).not.toBeNull();
  });

  it('"Advanced": the settings read before stay in the form, the failure is said', async () => {
    await act(async () => root.render(<AgentAdvancedSection agentId="claude" registries={[]} registry={undefined} onRegistryChange={vi.fn()} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-advanced-trigger"]')!.click());
    expect(host.querySelector<HTMLInputElement>('#agent-extraArgs')?.value).toBe('--fast');
    expect(said()).not.toBeNull();
  });

  it('[control] nothing failed: nothing said', async () => {
    h.list = { ...h.list, error: null };
    h.settings.error = null;
    await act(async () => root.render(<AgentsSettingsPage selectedAgentId={null} onSelectAgent={vi.fn()} />));
    expect(said()).toBeNull();
    await act(async () => root.render(<AgentAdvancedSection agentId="claude" registries={[]} registry={undefined} onRegistryChange={vi.fn()} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-advanced-trigger"]')!.click());
    expect(said()).toBeNull();
  });
});
