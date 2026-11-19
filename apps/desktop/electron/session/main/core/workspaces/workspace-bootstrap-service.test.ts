/**
 * #6264 升级上来的机器:重启前就有的会话,它的项目在新进程里还没被打开时,唤醒它(MCP 旧卡来敲门、云端投递)
 * 要当场把项目打开,❌ 报 `Project … not found`。
 *
 * 现场(2026-09-25 d22,server 0.2.157):两条会话建在旧版远端建会话用的 `task-home` 项目里(随机 id,
 * 目录 ~/.config/咕咕/task-home,不是固定 id 的隐藏任务工作区)。重启后它们在 tmux 里的 agent 6 秒内拿旧卡来敲门,
 * 那时启动时的 `openAllEmdashProjects` 还没打开这个项目 → 唤醒失败 → MCP 回 401 → 这条会话里的咕咕工具全部失效。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/core/folders/folders', () => ({ rootFolderOf: vi.fn() }));
vi.mock('@main/core/workspaces/folder-runtime/folder-runtimes', () => ({ folderRuntime: vi.fn() }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));
vi.mock('@main/core/sessions/session-builder', () => ({ buildSessionFromWorkspace: vi.fn(), emitSessionProvisionProgress: vi.fn() }));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { log };
});

const { WorkspaceBootstrapService } = await import('./workspace-bootstrap-service');

/** 只回答这一问要的那两行:会话行、工作区行。 */
function fakeDb() {
  const rows = [
    [{ id: 'session-1', workspaceId: 'ws-1', config: { version: '1', type: 'acp', agentDisplayName: 'late-cooks-wave' } }],
    [{ id: 'ws-1', type: 'local', kind: null, path: '/root/.config/咕咕/task-home', config: null }],
  ];
  let call = 0;
  const chain = { from: () => chain, where: () => chain, limit: async () => rows[call++] ?? [] };
  return { select: () => chain } as never;
}

describe('ensureWorkspaceSetupForSession on a machine that was just upgraded and restarted', () => {
  it('opens the root folder of the session\'s workspace on demand, then sets the workspace up', async () => {
    const folder = { folderId: 'task-home', repoPath: '/root/.config/咕咕/task-home' };
    const openRoot = vi.fn(async () => folder as never);
    const service = new WorkspaceBootstrapService(fakeDb(), openRoot);
    const setup = vi.spyOn(service, 'ensureWorkspaceSetup').mockResolvedValue({ success: true, data: {} } as never);

    await service.ensureWorkspaceSetupForSession('session-1');

    expect(openRoot).toHaveBeenCalledWith('ws-1');
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![2]).toBe(folder);
  });

  it('says so when the workspace is in no folder on this device', async () => {
    const service = new WorkspaceBootstrapService(fakeDb(), async () => null);
    await expect(service.ensureWorkspaceSetupForSession('session-1')).rejects.toThrow('in no folder on this device');
  });
});
