import type * as nodeCrypto from 'node:crypto';
import type * as fsPromises from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '@main/core/sessions/session-events';
import { ptySessionRegistry } from './pty-session-registry';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  getWorkspace: vi.fn(),
  getWorkspaceId: vi.fn(),
  randomUUID: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof nodeCrypto>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof fsPromises>();
  return { ...actual, readFile: mocks.readFile };
});

vi.mock('./persist-dropped-blob', () => ({
  cleanupExpiredDroppedBlobs: vi.fn().mockResolvedValue(undefined),
  persistClipboardImagePath: vi.fn(),
  persistDroppedBlobBytes: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../sessions/session-workspace-manager', () => ({
  sessionWorkspaceManager: {
    getSession: mocks.getSession,
    getWorkspaceId: mocks.getWorkspaceId,
  },
}));

vi.mock('@main/core/workspaces/folder-runtime/folder-runtimes', () => ({
  projectManager: {
    getProject: mocks.getProject,
  },
}));

vi.mock('../workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    get: mocks.getWorkspace,
  },
}));

const emitSpy = vi.spyOn(sessionEvents, '_emit');

const { ptyController } = await import('./controller');

function makePty(write = vi.fn()) {
  return {
    write,
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

describe('ptyController', () => {
  beforeEach(() => {
    emitSpy.mockClear();
    vi.clearAllMocks();
    mocks.getProject.mockReturnValue({});
  });

  it('emits input-submitted for agent PTYs on enter', async () => {
    const write = vi.fn();
    const ptySessionId = 'proj-1:task-1:conv-1';
    ptySessionRegistry.register(ptySessionId, makePty(write), {
      size: { cols: 80, rows: 24 },
      metadata: { providerId: 'amp' },
    });

    // The write resolves after the bytes land — a harness that declares a submit separation may hold
    // the submit key back briefly (#4525), so the verdict is awaited rather than read synchronously.
    const result = await ptyController.sendInput(ptySessionId, 'hello\r');

    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith('hello\r');
    expect(emitSpy).toHaveBeenCalledWith('session:input-submitted', {
      sessionId: 'conv-1',
      providerId: 'amp',
    });

    ptySessionRegistry.unregister(ptySessionId);
  });

  // #6183: 一条还在起的会话没有 PTY 注册 —— 「取消」就是停它。会不会被当成普通终端,由会话属主说了算。
  it('stops a conversation that is still starting (no PTY registered yet) through its provider', async () => {
    const sessionStop = vi.fn().mockResolvedValue(undefined);
    const killTerminal = vi.fn().mockResolvedValue(undefined);
    mocks.getSession.mockReturnValue({
      sessions: { ownsSession: (id: string) => id === 'conv-starting', stopSession: sessionStop },
      terminals: { killTerminal },
    });

    const result = await ptyController.stopSession('proj-1:task-1:conv-starting');

    expect(result).toEqual({ success: true, data: undefined });
    expect(sessionStop).toHaveBeenCalledWith('conv-starting');
    expect(killTerminal).not.toHaveBeenCalled();
  });

  it('still routes a plain terminal of the same task to killTerminal', async () => {
    const sessionStop = vi.fn();
    const killTerminal = vi.fn().mockResolvedValue(undefined);
    mocks.getSession.mockReturnValue({
      sessions: { ownsSession: () => false, stopSession: sessionStop },
      terminals: { killTerminal },
    });

    await ptyController.stopSession('proj-1:task-1:term-1');

    expect(killTerminal).toHaveBeenCalledWith('term-1');
    expect(sessionStop).not.toHaveBeenCalled();
  });
});
