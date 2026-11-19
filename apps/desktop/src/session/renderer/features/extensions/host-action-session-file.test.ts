// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_HOST_ACTION_METHOD } from '@shared/extensions/host-actions';

const state = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  prepare: vi.fn(), open: vi.fn(),
  /** Where this window's lists have each session (local folders), and what another machine's directory answers. */
  listed: new Map<string, string>(), reach: vi.fn(),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: state.projects }),
  projectOfSession: (sessionId: string) => state.listed.get(sessionId),
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { reachProject: state.reach } }));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }));
vi.mock('./extension-surface-store', () => ({ extensionSurfaceStore: { say: vi.fn() } }));
vi.mock('@renderer/features/sessions/session-pane-ready', () => ({ prepareSessionPane: state.prepare }));
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({ openFileInSessionEditor: state.open }));
const { extensionHostActionHandlers } = await import('./host-action-handlers');
const open = (deviceId: string | null = null) => extensionHostActionHandlers[EXTENSION_HOST_ACTION_METHOD]!({
  origin: { sessionId: null, tabId: 'group-folder' },
  action: { kind: 'openSessionFile', sessionId: 'target', deviceId, path: 'a.txt', ask: true },
});
beforeEach(() => {
  vi.clearAllMocks(); state.projects.clear(); state.open.mockResolvedValue(null);
  state.listed.clear(); state.listed.set('target', 'project'); state.reach.mockResolvedValue(null);
  state.prepare.mockImplementation(async (projectId: string) => {
    state.projects.set(projectId, { mountedProject: { sessionManager: { sessions: new Map([['target', { viewModel: {} }]]) } } });
  });
});
describe('an App opens a file in a target session that was not prepared', () => {
  it('prepares a session this window lists in its own folder', async () => {
    await expect(open()).resolves.toEqual({ ok: true, opened: undefined });
    expect(state.prepare).toHaveBeenCalledWith('project', 'target');
    expect(state.open).toHaveBeenCalledWith('project', 'target', 'a.txt', { ask: true, intent: undefined, byHost: true });
    expect(state.prepare.mock.invocationCallOrder[0]).toBeLessThan(state.open.mock.invocationCallOrder[0]!);
    expect(state.reach).not.toHaveBeenCalled();
  });
  it("another machine's session not listed here: its folder comes from that machine's session directory", async () => {
    state.listed.clear();
    state.reach.mockResolvedValueOnce('folder-workspace-1');
    await expect(open('remote-device')).resolves.toEqual({ ok: true, opened: undefined });
    expect(state.reach).toHaveBeenCalledWith('target', 'remote-device');
    expect(state.prepare).toHaveBeenCalledWith('folder-workspace-1', 'target');
  });
  it('a cancelled choice is nothing gone wrong: the App hears no error', async () => {
    state.open.mockResolvedValueOnce(undefined);
    await expect(open()).resolves.toMatchObject({ ok: true });
  });
  it('folder redesign carries intent and the source folder to a file in the same session', async () => {
    await extensionHostActionHandlers[EXTENSION_HOST_ACTION_METHOD]!({
      origin: { extensionId: 'workspace', sessionId: 'target', tabId: 'task-folder' },
      action: { kind: 'openSessionFile', sessionId: 'target', deviceId: null, path: 'a.txt', ask: false, intent: 'newTab' },
    });
    expect(state.open).toHaveBeenCalledWith('project', 'target', 'a.txt', { ask: false, intent: 'newTab', byHost: true, from: 'task-folder' });
  });
  it('refuses a session no list has without trying another source', async () => {
    state.listed.clear();
    await expect(open()).rejects.toThrow('not listed');
    await expect(open('remote-device')).rejects.toThrow('not listed');
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('does not acknowledge an unsuccessful open or failed preparation', async () => {
    state.open.mockRejectedValueOnce(new Error('The person did not pick an App to open it with'));
    await expect(open()).rejects.toThrow('did not pick');
    state.prepare.mockRejectedValueOnce(new Error('workspace unavailable'));
    await expect(open()).rejects.toThrow('workspace unavailable');
    expect(state.open).toHaveBeenCalledTimes(1);
  });
});
