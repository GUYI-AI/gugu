import { describe, expect, it } from 'vitest';
import { chosenFolderOf, rememberFolderChoice, type ShownFolder } from './project-folders';

const folder = (workspaceId: string, kind: ShownFolder['kind'], deviceId: string | null): ShownFolder => ({
  workspaceId, projectId: 'row-1', kind, path: `/work/${workspaceId}`, branch: null, sessionIds: [], attachedAt: null, offline: false, deviceId,
});

// #2640: picking a folder in the project picker is what the project block starts new tasks from.
describe('folder picked in the project picker', () => {
  const folders = [folder('ws-root', 'root', null), folder('ws-mac1', 'attached', 'mac1')];

  it('is the folder the project block starts from; without a pick it is the root', () => {
    expect(chosenFolderOf('row-no-pick', folders)?.workspaceId).toBe('ws-root');
    rememberFolderChoice('row-1', 'ws-mac1');
    expect(chosenFolderOf('row-1', folders)?.workspaceId).toBe('ws-mac1');
  });

  it('falls back to the root when the picked folder is gone', () => {
    rememberFolderChoice('row-2', 'ws-detached');
    expect(chosenFolderOf('row-2', folders)?.workspaceId).toBe('ws-root');
  });
});
