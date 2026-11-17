import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A library integration's detail when a reading read before fails to read again: the GitHub accounts, the account of a
// one-account integration, whether another machine has it. Each stays drawn and the failure is said beside it.
const h = vi.hoisted(() => {
  const failed = (value: unknown) => ({ state: 'value' as const, value, stale: false, error: new Error('machine unreachable') });
  return { failed, accounts: failed({ supported: true, accounts: [{ accountId: 'a1', displayName: 'ann@example.com', connectedAt: 0, fields: {} }] }), configured: failed({ notion: true }) };
});
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/features/integrations/integration-icon', () => ({ IntegrationIcon: () => null }));
vi.mock('./GitHubAccountsSection', () => ({ GitHubAccountRows: ({ accounts }: { accounts: { login: string }[] }) => React.createElement('ul', { 'data-testid': 'github-rows' }, accounts.map((a) => React.createElement('li', { key: a.login }, a.login))) }));
vi.mock('@renderer/features/integrations/use-integration-accounts', () => ({
  useIntegrationAccounts: () => ({ accounts: h.accounts, checks: { state: 'unknown' }, reachable: true, retry: vi.fn() }),
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { start: () => () => undefined, hosts: new Map([['studio', { device: { id: 'studio', label: 'Studio', isOnline: true, lastSeenAt: null } }]]) },
}));
vi.mock('@/lib/replica', async (original) => ({ ...(await original<object>()), useReplicas: () => [h.configured] }));

const { IntegrationDetailSidebar } = await import('./IntegrationDetailSidebar');

const integration = (over: Record<string, unknown>) => ({
  id: 'notion', name: 'Notion', description: '', icon: {} as never, features: [], isConfigured: true, isConfigurationKnown: true, isMutating: false,
  onConnect: vi.fn(), abilities: [], playbooks: [], multiAccount: false, ...over,
}) as never;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; vi.unstubAllGlobals(); });

async function render(props: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('navigator', dom.window.navigator);
  const root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  await act(async () => root.render(React.createElement(IntegrationDetailSidebar, { onClose: vi.fn(), githubAccounts: { state: 'unknown' }, ...props } as never)));
  cleanup = () => act(() => root.unmount());
  return dom.window.document;
}

describe('IntegrationDetailSidebar: a re-read that fails over what was read', () => {
  it('GitHub: the accounts read before stay listed and the failure is said', async () => {
    const doc = await render({ integration: integration({ id: 'github', name: 'GitHub' }), githubAccounts: h.failed([{ accountId: 'gh:1', login: 'octo' }]) });
    expect(doc.querySelector('[data-testid="github-rows"]')?.textContent).toBe('octo');
    expect(doc.querySelector('[data-refresh-failed]')).not.toBeNull();
  });

  it('one account: its name stays and the failure is said; another machine read before: its state stays and the failure is said', async () => {
    const doc = await render({ integration: integration({}) });
    expect(doc.querySelector('[data-testid="integration-connection-rows"]')?.textContent).toContain('ann@example.com');
    const said = [...doc.querySelectorAll('[data-refresh-failed]')];
    expect(said).toHaveLength(2);
    expect(doc.body.textContent).toContain('integrations.deviceConnected');
  });
});
