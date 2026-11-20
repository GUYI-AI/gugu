import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nodePty from 'node-pty';
import { LocalPtyOwner, spawnLocalPty } from './local-pty';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

describe('local pty', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('owner kills sessions that have not reported a native exit', () => {
    const owner = new LocalPtyOwner();
    const sessions = [1, 2].map(() => {
      let exitHandler: (() => void) | undefined;
      return {
        kill: vi.fn(),
        onExit: vi.fn((handler: () => void) => {
          exitHandler = handler;
        }),
        exit: () => exitHandler?.(),
      };
    });
    sessions.forEach((session) => owner.own(session));
    sessions[0]!.exit();

    owner.dispose();

    expect(sessions.map((session) => session.kill.mock.calls.length)).toEqual([0, 1]);
    expect(() => owner.assertAccepting()).toThrow('Local PTY owner is disposing');
  });

  // Windows 自带的 ConPTY 吃掉 TUI 问背景色的 OSC 10/11,两端配色因此不一致
  // (根因与实测见 @gugu/session-core 的 pty/node/conpty.ts)。钉住这个选项确实传到了 node-pty。
  it('spawns through the bundled ConPTY so terminal queries reach the host', () => {
    const spawnSpy = vi.mocked(nodePty.spawn);
    spawnSpy.mockReturnValue({
      pid: 4321,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    } as unknown as ReturnType<typeof nodePty.spawn>);

    spawnLocalPty({
      id: 'conpty-test',
      command: 'agent',
      args: ['--login'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'agent',
      ['--login'],
      expect.objectContaining({ useConptyDll: true })
    );
  });
});
