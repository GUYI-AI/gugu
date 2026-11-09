// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// owner 2026-11-09: a PDF overwritten on a Gugu server kept showing the old pages until its tab was closed.
const h = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    watchDirectory: vi.fn(async () => ({ success: true, data: { leaseId: 'lease-1' } })),
    releaseDirectoryWatch: vi.fn(async () => {}),
  };
});

vi.mock('../workspace-backend/workspace-backend', () => ({
  workspaceBackend: () => ({ elsewhere: true }),
  workspaceEvents: { on: (_channel: unknown, listener: (event: unknown) => void) => { h.listeners.add(listener); return () => h.listeners.delete(listener); } },
  workspaceRpc: () => ({ files: { watchDirectory: h.watchDirectory, releaseDirectoryWatch: h.releaseDirectoryWatch } }),
}));
vi.mock('@/components/chat/MessageFilePreview', () => ({
  MessageFilePreview: ({ file }: { file: { source: { key: string } } }) => <div data-key={file.source.key} />,
}));
vi.mock('../stores/open-file-in-file-editor', () => ({ openPathWithFailureToast: vi.fn() }));
vi.mock('../stores/session-selectors', () => ({ getSessionView: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/remote-hosts/workspace/remote-file-actions', () => ({ downloadSessionFile: vi.fn() }));
vi.mock('@renderer/lib/editor/quote-workspace-file', () => ({ quoteWorkspaceFile: vi.fn() }));
vi.mock('./file-view-kinds', () => ({ FOLDER_APP_FILE_TAB: 'folder', openFolderInTab: vi.fn() }));

import { WorkspaceFileView } from './workspace-file-view';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.listeners.clear();
  h.watchDirectory.mockClear();
  h.releaseDirectoryWatch.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const draw = (inWorkspace: boolean, absolutePath = '/home/task/hw1.pdf') => act(() => root.render(
  <WorkspaceFileView projectId="p" workspaceId="w" path={absolutePath} absolutePath={absolutePath} inWorkspace={inWorkspace} onClose={() => {}} />
));

it('watches the directory of the file it shows, reads it again when it changes there, and lets the watch go when closed', async () => {
  await draw(true);
  expect(h.watchDirectory.mock.calls).toEqual([['p', 'w', '/home/task']]);
  const before = container.querySelector('[data-key]')!.getAttribute('data-key');

  await act(async () => { for (const listener of h.listeners) listener({ workspaceId: 'w', update: { kind: 'changes', changes: [{ kind: 'update', path: '/home/task/hw1.pdf' }] } }); });
  expect(container.querySelector('[data-key]')!.getAttribute('data-key')).not.toBe(before);

  await act(async () => root.unmount());
  root = createRoot(container);
  await vi.waitFor(() => expect(h.releaseDirectoryWatch.mock.calls).toEqual([['p', 'w', 'lease-1']]));
});

it('watches nothing for a file outside the workspace: no change feed carries it', async () => {
  await draw(false);
  expect(h.watchDirectory).not.toHaveBeenCalled();
});

it('watches the folder of a Windows path, not the path cut by one character', async () => {
  await draw(true, 'C:\\Users\\me\\task\\hw1.pdf');
  expect(h.watchDirectory.mock.calls).toEqual([['p', 'w', 'C:\\Users\\me\\task']]);
});
