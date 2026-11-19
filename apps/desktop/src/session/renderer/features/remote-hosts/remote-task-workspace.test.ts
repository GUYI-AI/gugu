// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// #609(owner 10-28):别的机器上没选文件夹 ⇒ 那台机器的任务工作区(与本机一样列在「任务」),❌ 在那台机器上把 ~ 建成项目。
describe('没选文件夹 = 那台机器的任务工作区', () => {
  afterEach(() => vi.restoreAllMocks());

  it('问那台机器要它的 task home(那台记着它),同时要两次只问一次', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { RemoteHostsStore } = await import('./remote-hosts-store');
    const store = new RemoteHostsStore();
    const home = vi.spyOn(appState.projects, 'ensureTaskHome').mockResolvedValue('task-home-d22');

    const [a, b] = await Promise.all([store.ensureTaskWorkspace('d22'), store.ensureTaskWorkspace('d22')]);
    expect(a).toBe('task-home-d22');
    expect(b).toBe(a);
    expect(home).toHaveBeenCalledTimes(1);
    expect(home).toHaveBeenCalledWith('d22');
  });

  it('新建框没选项目走它;项目块定好的本地项目直接用,不再按路径找或建', async () => {
    const { remoteHostsStore } = await import('./remote-hosts-store');
    const { resolveMachineProject } = await import('@renderer/features/sessions/use-machine-create-target');
    const tasks = vi.spyOn(remoteHostsStore, 'ensureTaskWorkspace').mockResolvedValue('tw');

    await expect(resolveMachineProject({ deviceId: 'd24' })).resolves.toBe('tw');
    await expect(resolveMachineProject({ deviceId: 'd24', projectId: 'bound' })).resolves.toBe('bound');
    expect(tasks).toHaveBeenCalledTimes(1);
  });
});
