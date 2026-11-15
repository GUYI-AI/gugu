import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalManagerStore } from './terminal-manager';

const createTerminal = vi.hoisted(() => vi.fn());
const getTerminalsForSession = vi.hoisted(() => vi.fn());
const hydrateTerminal = vi.hoisted(() => vi.fn());
const renameTerminal = vi.hoisted(() => vi.fn());
const deleteTerminal = vi.hoisted(() => vi.fn());
const frontendConnect = vi.hoisted(() => vi.fn());
const frontendDispose = vi.hoisted(() => vi.fn());
const getAppSettingValueSnapshot = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/settings/app-settings-client', () => ({
  getAppSettingValueSnapshot,
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    app: {
      openPath: vi.fn(),
    },
    fs: {
      fileExists: vi.fn(),
    },
    ssh: {
      getConnections: async () => [],
      getConnectionState: async () => ({}),
      getHealthStates: async () => ({}),
    },
    terminals: {
      createTerminal,
      deleteTerminal,
      getTerminalsForSession,
      hydrateTerminal,
      renameTerminal,
    },
  },
}));

vi.mock('@renderer/lib/pty/pty', () => ({
  loadXterm: async () => {},
  FrontendPty: class {
    constructor(readonly ptySessionId: string) {}

    connect = frontendConnect;
    dispose = frontendDispose;
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

const newTerminal = (store: TerminalManagerStore) =>
  store.createTerminal({ id: 'terminal-1', projectId: 'project-1', sessionId: 'session-1', name: 'Terminal 1' });

const startShell = async (store: TerminalManagerStore, dims?: { cols: number; rows: number }) => {
  const session = store.sessions.get('terminal-1')!;
  await session.connect();
  (session.pty as unknown as { onGridMeasured(dims?: object): void }).onGridMeasured(dims);
};

describe('TerminalManagerStore session hydration', () => {
  beforeEach(() => {
    createTerminal.mockReset();
    getTerminalsForSession.mockReset();
    hydrateTerminal.mockReset();
    renameTerminal.mockReset();
    deleteTerminal.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();
    getAppSettingValueSnapshot.mockReset();

    createTerminal.mockImplementation(async (terminal) => terminal);
    getTerminalsForSession.mockResolvedValue([]);
    hydrateTerminal.mockResolvedValue(undefined);
    renameTerminal.mockResolvedValue(undefined);
    deleteTerminal.mockResolvedValue(undefined);
    frontendConnect.mockResolvedValue(undefined);
    getAppSettingValueSnapshot.mockReturnValue(undefined);
  });

  it('creates terminal sessions from records without hydrating until the session connects', async () => {
    getTerminalsForSession.mockResolvedValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        shellId: 'system',
        name: 'Terminal 1',
      },
    ]);
    const store = new TerminalManagerStore('project-1', 'session-1');

    store.list.setValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        shellId: 'system',
        name: 'Terminal 1',
      },
    ]);

    expect(hydrateTerminal).not.toHaveBeenCalled();

    const session = store.sessions.get('terminal-1');
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(hydrateTerminal).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      terminalId: 'terminal-1',
    });
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    await session?.connect();

    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('uses the cached default shell for optimistic terminals when no shell is specified', async () => {
    getAppSettingValueSnapshot.mockReturnValue({ defaultShell: 'fish' });
    createTerminal.mockResolvedValue({
      id: 'terminal-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      shellId: 'fish',
      name: 'Terminal 1',
    });
    const store = new TerminalManagerStore('project-1', 'session-1');

    const { created } = newTerminal(store);

    expect(store.terminals.get('terminal-1')?.data.shellId).toBe('fish');
    await startShell(store);
    await created;
    store.dispose();
  });

  it('starts the shell at the grid the tab measured, and not before', async () => {
    const store = new TerminalManagerStore('project-1', 'session-1');
    const { created } = newTerminal(store);
    const session = store.sessions.get('terminal-1')!;

    await session.connect();
    expect(hydrateTerminal).not.toHaveBeenCalled();
    expect(createTerminal).not.toHaveBeenCalled();

    (session.pty as unknown as { onGridMeasured(dims: object): void }).onGridMeasured({ cols: 61, rows: 40 });
    (session.pty as unknown as { onGridMeasured(dims: object): void }).onGridMeasured({ cols: 99, rows: 9 });
    await created;

    expect(createTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'terminal-1', initialSize: { cols: 61, rows: 40 } }));
    store.dispose();
  });

  it('starts at the default size when the xterm gives up measuring', async () => {
    const store = new TerminalManagerStore('project-1', 'session-1');
    const { created } = newTerminal(store);
    await startShell(store);
    await created;
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith(expect.not.objectContaining({ initialSize: expect.anything() }));
    store.dispose();
  });

  it('never starts a shell on its own: a tab never shown, then disposed, leaves nothing running', async () => {
    const store = new TerminalManagerStore('project-1', 'session-1');
    newTerminal(store);
    await store.sessions.get('terminal-1')!.connect();
    store.dispose();
    await Promise.resolve();
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('closed while the create request is out: ended after it returns, not before', async () => {
    let finish!: (value: unknown) => void;
    createTerminal.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const store = new TerminalManagerStore('project-1', 'session-1');
    newTerminal(store);
    await startShell(store);
    await vi.waitFor(() => expect(createTerminal).toHaveBeenCalledOnce());
    const closing = store.deleteTerminal('terminal-1');
    await Promise.resolve();
    expect(deleteTerminal).not.toHaveBeenCalled();
    finish({ id: 'terminal-1' });
    await closing;
    expect(deleteTerminal).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('closed while starting: the shell is ended, never left running', async () => {
    const store = new TerminalManagerStore('project-1', 'session-1');
    const { created } = newTerminal(store);
    await store.deleteTerminal('terminal-1');
    expect(await created).toBeUndefined();
    expect(createTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('a failed start takes the terminal back out and reports it', async () => {
    createTerminal.mockRejectedValue(new Error('no shell'));
    const store = new TerminalManagerStore('project-1', 'session-1');
    const { created } = newTerminal(store);
    await startShell(store);
    await expect(created).rejects.toThrow('no shell');
    expect(store.terminals.has('terminal-1')).toBe(false);
    store.dispose();
  });
});
