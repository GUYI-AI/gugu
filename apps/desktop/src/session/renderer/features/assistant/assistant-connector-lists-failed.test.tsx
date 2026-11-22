// @vitest-environment jsdom
// E-4: which connectors are connected could not be read: the list says so with a retry (❌ a placeholder for ever).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reloadConnections = vi.fn();
vi.mock('@renderer/features/integrations/integrations-provider', () => ({
  useIntegrationsContext: () => ({
    integrations: [{ id: 'notion', name: 'Notion', description: '', icon: null }], configuredConnections: null,
    configuredConnectionsError: new Error('offline'), connectionStatus: null, hasList: true, listError: null,
    reloadList: () => undefined, reloadConnections,
  }),
}));
vi.mock('@renderer/features/library/library-host', async (original) => ({ ...await original<object>(), useLibraryHost: () => ({ remote: null }) }));

const { ConnectorLists } = await import('./assistant-home-integrations');

it('says the connected list could not be read, and retries it', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<ConnectorLists onOpen={() => undefined} />));
  const failed = host.querySelector('[data-testid="assistant-connectors-read-failed"]');
  expect(failed).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
  expect(reloadConnections).toHaveBeenCalled();
  await act(async () => root.unmount());
});
