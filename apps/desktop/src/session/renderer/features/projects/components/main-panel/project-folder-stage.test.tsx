// @vitest-environment jsdom
// A new task in a project runs on the machine picked in the tray. While the folder list is still loading, the composer's
// machine (reachability notice, model catalog) must already be that one — not the machine the page's project row lives on,
// which can be an offline machine the person did not pick.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machineOf: Record<string, string> = { 'p-off': 'dev-off', 'p-on': 'dev-on' };
const online = new Set(['dev-on']);
const folders = vi.hoisted(() => ({ state: { folders: null as unknown[] | null, unanswered: [] as string[], chosen: null } }));
const createContext = vi.hoisted(() => vi.fn((_target: unknown) => null));

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/sessions/use-machine-create-target', () => ({ useMachineCreateContext: createContext }));
vi.mock('@renderer/features/remote-hosts/use-new-session-machine', () => ({ remoteChoice: (id: string) => ({ id }) }));
vi.mock('@renderer/features/remote-hosts/machine-picker', () => ({ MachinePicker: () => null }));
vi.mock('./project-folder-card', () => ({ ProjectFolderCard: () => null, shortHome: (path: string) => path }));
vi.mock('./project-folders', () => ({
  MAX_PROJECT_FOLDERS: 6,
  useProjectFolders: () => ({ ...folders.state, loadError: false, fresh: undefined, choose: () => {}, reload: () => {}, attach: vi.fn(), detach: vi.fn() }),
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectStore: () => null, projectDisplayName: () => 'work' }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { rowProjectIdOf: (id: string) => id, projectMembersOf: () => ['p-off', 'p-on'], placement: { entries: new Map() } },
}));
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({
  accountProjectsStore: { projectOfLocal: () => undefined, localDeviceId: 'this-computer' },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: (id: string) => machineOf[id] } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    device: (id: string) => ({ label: id, hostKind: 'server' }),
    connectionState: (id: string) => (online.has(id) ? 'connected' : 'offline'),
    pickableMachineIds: () => ['dev-off', 'dev-on'],
    start: () => () => {},
    canAddMachine: false,
  },
}));
vi.mock('@renderer/features/projects/hooks/use-ensure-mounted', () => ({ useEnsureMounted: () => {} }));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: {} }));
vi.mock('@renderer/features/projects/project-link-deps', () => ({ projectLinkDeps: () => ({}) }));
vi.mock('@shared/core/projects/project-attach-flow', () => ({ linkFolderOnMachine: vi.fn(), planAttach: vi.fn() }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, rpcOn: () => ({}) }));
vi.mock('@renderer/lib/electron-api', () => ({ electronApi: () => ({}) }));
vi.mock('@/lib/agentCreateDefaults', () => ({ readAgentCreateDefaults: async () => ({ machineByProject: {} }) }));

const { useProjectFolderStage } = await import('./project-folder-stage');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  createContext.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function Stage({ projectId }: { projectId: string }) {
  useProjectFolderStage(projectId, { floating: true });
  return null;
}

describe('new task in a project: the machine it runs on', () => {
  it('while folders load, targets the picked (online) machine, not the offline machine the page project lives on', async () => {
    folders.state = { folders: null, unanswered: ['p-off', 'p-on'], chosen: null };
    await act(async () => root.render(<Stage projectId="p-off" />));
    expect(createContext).toHaveBeenLastCalledWith({ deviceId: 'dev-on', projectId: 'p-on' });
    expect(createContext.mock.calls.some(([target]) => (target as { deviceId?: string } | null)?.deviceId === 'dev-off')).toBe(false);
  });

  it('the offline machine answering first (with its recorded folders) does not make it the default before the online one answers', async () => {
    const recorded = { deviceId: 'dev-off', projectId: 'p-off', workspaceId: 'w-off', kind: 'root', path: '/work', offline: true };
    folders.state = { folders: [recorded], unanswered: ['p-on'], chosen: null };
    await act(async () => root.render(<Stage projectId="p-off" />));
    expect(createContext).toHaveBeenLastCalledWith({ deviceId: 'dev-on', projectId: 'p-on' });
    expect(createContext.mock.calls.some(([target]) => (target as { deviceId?: string } | null)?.deviceId === 'dev-off')).toBe(false);
  });
});
