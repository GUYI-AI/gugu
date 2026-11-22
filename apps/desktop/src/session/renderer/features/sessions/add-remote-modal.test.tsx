// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/** The owners of the project's GitHub account, read before: a re-read that fails is said with a retry, the owners still offered. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ error: new Error('github unreachable') as Error | null, retry: vi.fn() }));
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectSettingsStore: () => ({ settings: { githubAccountId: 'gh:1' }, pageData: { data: {}, error: null } }),
  getGitRepositoryStore: () => null,
}));
vi.mock('@renderer/lib/hooks/useGithubRepositoryOwners', () => ({
  useGitHubRepositoryOwnerSelect: () => ({
    owners: { state: 'value', value: [{ value: 'octo', label: 'octo' }], stale: false, error: h.error },
    owner: { value: 'octo', label: 'octo' }, retry: h.retry, handleOwnerChange: vi.fn(),
  }),
}));
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { DialogContentArea: pass, DialogFooter: pass, DialogHeader: pass, DialogTitle: pass };
});
vi.mock('@renderer/lib/ui/modal-layout', () => ({ ModalLayout: ({ header, children }: { header: React.ReactNode; children: React.ReactNode }) => React.createElement('div', null, header, children) }));
vi.mock('@renderer/lib/ui/combobox-popover', () => ({ ComboboxPopover: ({ items }: { items: { label: string }[] }) => React.createElement('div', { 'data-testid': 'owners' }, items.map((item) => item.label).join(',')) }));

const { AddRemoteModal } = await import('./add-remote-modal');

async function draw() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { projectId: 'p', projectName: 'demo', branchName: 'main', workspaceId: 'w', onSuccess: vi.fn(), onClose: vi.fn() } as unknown as React.ComponentProps<typeof AddRemoteModal>;
  await act(async () => root.render(<AddRemoteModal {...props} />));
  const out = { owners: host.querySelector('[data-testid="owners"]')?.textContent, failed: host.querySelector('[data-read-failed]') };
  out.failed?.querySelector('button')?.click();
  act(() => root.unmount());
  return out;
}

describe('AddRemoteModal owners', () => {
  it('read before, a re-read that fails: the owners stay offered and the failure is said with a retry', async () => {
    h.error = new Error('github unreachable');
    const drawn = await draw();
    expect(drawn.owners).toBe('octo');
    expect(drawn.failed?.textContent).toContain('github unreachable');
    expect(h.retry).toHaveBeenCalled();
  });

  it('[control] read and current: nothing said', async () => {
    h.error = null;
    expect((await draw()).failed).toBeNull();
  });
});
