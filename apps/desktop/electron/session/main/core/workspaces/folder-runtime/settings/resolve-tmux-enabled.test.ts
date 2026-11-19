import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appSettingsService } from '@main/core/settings/settings-service';
import { resolveTmuxEnabled } from './resolve-tmux-enabled';

vi.mock('@main/core/folders/folders', () => ({ isTaskHomeFolder: (id: string) => id === 'task-home' }));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

const settingsWith = (tmux: boolean | undefined) =>
  ({ get: vi.fn(async () => ({ defaultBranch: 'main', baseRemote: 'origin', tmux })) }) as never;

describe('#4467 tmux 与否:spawn 与退出拆除共用一个答案', () => {
  beforeEach(() => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ tmuxByDefault: true } as never);
  });

  it('follows the global default for the implicit task home even when its stored seed says false', async () => {
    // mac1 实读:隐式任务工作区在打开 tmux 之前建好,种子 false;全局已开 ⇒ 会话跑在 tmux 里,退出也必须 detach。
    await expect(resolveTmuxEnabled(settingsWith(false), 'task-home')).resolves.toBe(true);
  });

  it('honours an explicit per-project choice for ordinary projects', async () => {
    await expect(resolveTmuxEnabled(settingsWith(false), 'folder-1')).resolves.toBe(false);
    await expect(resolveTmuxEnabled(settingsWith(undefined), 'folder-1')).resolves.toBe(true);
  });

  it('#6264 on 咕咕 server with the bundled tmux, always runs in tmux regardless of the stored seed', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ tmuxByDefault: false } as never);
    const env = { GUGU_SERVER_MODE: '1', GUGU_TMUX_BIN: '/srv/.gugu-server/current/app/tmux-bundle/tmux' };
    await expect(resolveTmuxEnabled(settingsWith(false), 'folder-1', env)).resolves.toBe(true);
    await expect(resolveTmuxEnabled(settingsWith(undefined), 'task-home', env)).resolves.toBe(true);
  });

  it('#6264 a server without a bundled tmux (dev run) still follows the settings', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ tmuxByDefault: false } as never);
    await expect(resolveTmuxEnabled(settingsWith(undefined), 'folder-1', { GUGU_SERVER_MODE: '1' })).resolves.toBe(false);
    await expect(resolveTmuxEnabled(settingsWith(undefined), 'folder-1', { GUGU_TMUX_BIN: '/x/tmux' })).resolves.toBe(false);
  });
});
