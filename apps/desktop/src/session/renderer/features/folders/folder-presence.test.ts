import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  folders: new Map<string, unknown>(),
  awaiting: false,
  roster: new Set<string>(),
  read: new Set<string>(),
  sessionsIn: new Map<string, string>(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { projects: { projects: mocks.folders } },
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    awaitsMachineLists: () => mocks.awaiting,
    device: (id: string) => (mocks.roster.has(id) ? { id } : null),
    hasReadList: (id: string) => mocks.read.has(id),
    machineWithSessionsIn: (folderId: string) => {
      const machine = mocks.sessionsIn.get(folderId);
      return machine && mocks.roster.has(machine) ? machine : null;
    },
  },
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => undefined }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ sessionLeaveDestination: () => ({ viewId: 'home' }) }));

const { folderPresence } = await import('./folder-presence');
const { sessionViewCanActivate } = await import('@renderer/features/sessions/session-view-guard');

// Restoring the last view at boot: a folder of another machine is not in the table yet — its list comes later.
// Only a folder known to be gone sends the person away.
describe('folder presence: "not in the table yet" is not "deleted"', () => {
  beforeEach(() => {
    mocks.folders.clear();
    mocks.awaiting = false;
    mocks.roster.clear();
    mocks.read.clear();
    mocks.sessionsIn.clear();
  });

  it('tells present, unknown and deleted apart', () => {
    mocks.folders.set('local', {});
    expect(folderPresence('local')).toBe('present');
    expect(folderPresence('gone')).toBe('deleted');
    // other machines' lists not all in yet (the restore at boot, before the machine roster is attached)
    mocks.awaiting = true;
    expect(folderPresence('on-a-server')).toBe('unknown');
    expect(folderPresence('local')).toBe('present');
  });

  it('the session guard lets an unknown folder through and sends a deleted one home', () => {
    mocks.awaiting = true;
    expect(sessionViewCanActivate({ projectId: 'on-a-server', sessionId: 's' })).toEqual({ ok: true });
    mocks.awaiting = false;
    expect(sessionViewCanActivate({ projectId: 'gone', sessionId: 's' })).toEqual({ ok: false, redirect: 'home' });
  });

  // #3425 A machine's task home is in no group, so no account record lists it (#609): its absence from the table says
  // nothing until that machine's own list has been read. Restoring a view on it must not read as "deleted".
  describe('the task home of another machine', () => {
    const home = 'task-home-of-dev-other';

    it('is unknown while a machine in the roster has sessions there and its own list is not read, deleted once it is read without it', () => {
      mocks.roster.add('dev-other');
      mocks.sessionsIn.set(home, 'dev-other');
      expect(folderPresence(home)).toBe('unknown');
      mocks.read.add('dev-other');
      expect(folderPresence(home)).toBe('deleted');
    });

    it('is deleted when the machine is no longer in the roster, and a folder no machine has sessions in stays judged by the table', () => {
      mocks.sessionsIn.set(home, 'dev-gone');
      expect(folderPresence(home)).toBe('deleted');
      mocks.roster.add('dev-other');
      expect(folderPresence('ordinary-folder-of-dev-other')).toBe('deleted');
    });

    it('the session guard lets it through while unknown', () => {
      mocks.roster.add('dev-other');
      mocks.sessionsIn.set(home, 'dev-other');
      expect(sessionViewCanActivate({ projectId: home, sessionId: 's' })).toEqual({ ok: true });
    });
  });
});
