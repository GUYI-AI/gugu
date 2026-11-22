import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodePtyProcess, NodePtySpawner } from './node-pty-spawner';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

describe('NodePtySpawner', () => {
  it('lazy-loads node-pty and adapts the spawned process', async () => {
    const proc = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    spawnMock.mockReturnValue(proc);

    const spawned = await new NodePtySpawner().spawn({
      command: 'agent',
      args: ['--login'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
    });

    // useConptyDll:Windows 自带的 ConPTY 会吃掉 TUI 问背景色的 OSC 10/11,
    // 两端配色因此不一致(见 ./conpty.ts)。这里钉住「这个选项确实传到了 node-pty」。
    expect(spawnMock).toHaveBeenCalledWith('agent', ['--login'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      useConptyDll: true,
    });
    spawned.write('input');
    spawned.resize(100, 30);
    expect(proc.write).toHaveBeenCalledWith('input');
    expect(proc.resize).toHaveBeenCalledWith(100, 30);
  });
});

describe('NodePtyProcess', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...originalPlatform, value });
  afterEach(() => Object.defineProperty(process, 'platform', originalPlatform));

  function create(pid = 1234) {
    const proc = { pid, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const terminator = { kill: vi.fn(), markExited: vi.fn() };
    return { proc, terminator, pty: new NodePtyProcess(proc, terminator) };
  }

  it('kill() delegates POSIX process-tree termination', () => {
    setPlatform('linux');
    const { proc, terminator, pty } = create();
    pty.kill();
    expect(terminator.kill).toHaveBeenCalledTimes(1);
    const [pid, killPty] = terminator.kill.mock.calls[0]!;
    expect(pid).toBe(1234);
    expect(proc.kill).not.toHaveBeenCalled();
    killPty();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('kill() does not use POSIX termination on Windows', () => {
    setPlatform('win32');
    const { proc, terminator, pty } = create();
    pty.kill();
    expect(terminator.kill).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('kill() falls back to node-pty when pid is unavailable', () => {
    setPlatform('linux');
    const { proc, terminator, pty } = create(0);
    pty.kill();
    expect(terminator.kill).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('marks the terminator exited even when nobody subscribed to exit', () => {
    const { proc, terminator } = create();
    proc.onExit.mock.calls[0]![0]({ exitCode: 0 });
    expect(terminator.markExited).toHaveBeenCalledTimes(1);
  });
});
