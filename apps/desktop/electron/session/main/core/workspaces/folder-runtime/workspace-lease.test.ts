import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFolderWorkspace, acquireTaskDirectory, releaseFolderWorkspace } from './workspace-lease';

const mocks = vi.hoisted(() => ({
  rootFolderOf: vi.fn(),
  isTaskHomeFolder: vi.fn(),
  openFolder: vi.fn(),
  ensureWorkspace: vi.fn(),
  acquire: vi.fn(),
  teardown: vi.fn(),
  listForFolder: vi.fn(),
  workspaceAtDirectory: vi.fn(),
}));

vi.mock('@main/core/folders/folders', () => ({
  rootFolderOf: mocks.rootFolderOf,
  isTaskHomeFolder: mocks.isTaskHomeFolder,
}));
vi.mock('./folder-runtimes', () => ({ openFolder: mocks.openFolder }));
vi.mock('@main/core/workspaces/workspace-bootstrap-service', () => ({
  workspaceBootstrapService: { ensureWorkspaceSetupForWorkspace: mocks.ensureWorkspace },
}));
vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: { acquire: mocks.acquire, teardown: mocks.teardown, listForFolder: mocks.listForFolder },
}));
vi.mock('@main/core/workspaces/workspace-at-directory', () => ({ workspaceAtDirectory: mocks.workspaceAtDirectory }));

describe('folder workspace lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rootFolderOf.mockImplementation((id: string) => (id === 'other' ? { id: 'folder-2' } : { id: 'folder-1' }));
    mocks.openFolder.mockResolvedValue({ success: true, data: {} });
    mocks.ensureWorkspace.mockImplementation(async (id: string) => ({ id }));
    mocks.acquire.mockImplementation(async (id: string) => ({ workspace: { id } }));
    mocks.listForFolder.mockReturnValue([{ workspaceId: 'folder-1', path: '/tmp/folder-1' }]);
    mocks.teardown.mockResolvedValue(undefined);
  });

  it('mounts the folder and holds it for the draft, keyed by the folder', async () => {
    expect(await acquireFolderWorkspace('folder-1', 'folder-1')).toEqual({ success: true, data: { workspaceId: 'folder-1' } });
    expect(mocks.ensureWorkspace).toHaveBeenCalledWith('folder-1');
    expect(mocks.acquire).toHaveBeenCalledWith('folder-1', 'folder-1', expect.any(Function));
  });

  it('holds a directory inside the folder the same way', async () => {
    expect(await acquireFolderWorkspace('folder-1', 'inside')).toEqual({ success: true, data: { workspaceId: 'inside' } });
    expect(mocks.acquire).toHaveBeenCalledWith('inside', 'folder-1', expect.any(Function));
  });

  it('refuses a workspace of another folder', async () => {
    expect(await acquireFolderWorkspace('folder-1', 'other')).toEqual({
      success: false,
      error: { type: 'not-found', message: 'Folder workspace not found' },
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('says so when the folder cannot be opened', async () => {
    mocks.openFolder.mockResolvedValue({ success: false, error: { type: 'path-not-found', path: '/gone' } });
    expect(await acquireFolderWorkspace('folder-1', 'folder-1')).toMatchObject({ success: false, error: { type: 'folder-not-open' } });
  });

  it('releases only a workspace currently held for the folder', async () => {
    expect(await releaseFolderWorkspace('folder-1', 'folder-1')).toEqual({ success: true });
    expect(mocks.teardown).toHaveBeenCalledWith('folder-1', 'detach');
    mocks.listForFolder.mockReturnValue([]);
    expect(await releaseFolderWorkspace('folder-1', 'other')).toEqual({ success: true });
    expect(mocks.teardown).toHaveBeenCalledTimes(1);
  });

  it('acquires a task directory only from the task home', async () => {
    mocks.isTaskHomeFolder.mockReturnValue(false);
    await expect(acquireTaskDirectory('folder-1', '/tmp/x')).rejects.toThrow('task workspace');
    mocks.isTaskHomeFolder.mockReturnValue(true);
    mocks.workspaceAtDirectory.mockReturnValue('inside');
    expect(await acquireTaskDirectory('folder-1', '/tmp/x')).toEqual({ success: true, data: { workspaceId: 'inside' } });
  });
});
