import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionBootTasks } from '../../boot-tasks';
import { openProject } from './openProject';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  probePathAccess: vi.fn(),
  openProject: vi.fn(),
}));

vi.mock('./getProjects', () => ({ getProjectById: mocks.getProjectById }));
vi.mock('../path-utils', () => ({ checkIsValidDirectory: () => true }));
vi.mock('./ensure-repository-workspace', () => ({ ensureRepositoryWorkspace: () => 'workspace-1' }));
vi.mock('./probe-path-access', () => ({
  PATH_ACCESS_PROBE_TIMEOUT_MS: 3_000,
  probePathAccess: mocks.probePathAccess,
}));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { openProject: mocks.openProject },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const opened = { success: true, data: { repositoryWorkspaceId: 'workspace-1', baseRef: 'main' } };

function arrange(platform: NodeJS.Platform, probe: { kind: 'ok' } | { kind: 'blocked' }) {
  Object.defineProperty(process, 'platform', { value: platform });
  mocks.getProjectById.mockResolvedValue({ id: 'p1', type: 'local', path: '/root/work', baseRef: 'main' });
  mocks.probePathAccess.mockResolvedValue(probe);
  mocks.openProject.mockResolvedValue({ success: true, data: { resolveGitless: async () => false } });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  sessionBootTasks.clearTask('p1');
  vi.clearAllMocks();
});

describe('openProject path access probe', () => {
  it('does not judge a Linux project permission-blocked from a probe timeout', async () => {
    // 探测超时 = 进程忙(启动时线程池 / 事件循环拥塞),一个完全可读的目录也会这样。
    arrange('linux', { kind: 'blocked' });
    await expect(openProject('p1')).resolves.toEqual(opened);
    expect(mocks.openProject).toHaveBeenCalledOnce();
  });

  it('still fails fast with the underlying error when a Linux path is unreadable', async () => {
    arrange('linux', { kind: 'ok' });
    mocks.probePathAccess.mockResolvedValue({ kind: 'failed', message: "EACCES: permission denied, opendir '/root/work'" });
    await expect(openProject('p1')).resolves.toEqual({
      success: false,
      error: { type: 'error', message: "EACCES: permission denied, opendir '/root/work'" },
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it('still reports a pending macOS permission prompt as path-access-blocked (#3611)', async () => {
    arrange('darwin', { kind: 'blocked' });
    await expect(openProject('p1')).resolves.toEqual({
      success: false,
      error: { type: 'path-access-blocked', path: '/root/work' },
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it('clears the boot-time open failure once the project opens later', async () => {
    // 启动时被误判记下的失败,不能一直挂在设备页上直到下次重启;按需打开成功就该清掉。
    sessionBootTasks.record('project-open', 'p1', { type: 'path-access-blocked', path: '/root/work' });
    arrange('darwin', { kind: 'ok' });
    await expect(openProject('p1')).resolves.toEqual(opened);
    expect(sessionBootTasks.snapshot()).not.toContainEqual(expect.objectContaining({ taskId: 'p1' }));
  });
});
