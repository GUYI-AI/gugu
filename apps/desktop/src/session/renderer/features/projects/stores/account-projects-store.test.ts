import { runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { AccountProjectsStore } from './account-projects-store';

const read = vi.hoisted(() => ({
  list: vi.fn<() => Promise<AccountProject[]>>(),
  self: vi.fn(async () => ({ device_id: 'this-computer' })),
  events: new Map<string, () => void>(),
  identified: null as null | (() => void),
}));
vi.mock('@/lib/deviceProjects', () => ({ listMyAccountProjects: () => read.list() }));
vi.mock('@/platform', () => ({ platform: {
  getLocalDeviceSelfSnapshot: () => read.self(),
  subscribeLocalDeviceIdentified: (listener: () => void) => { read.identified = listener; return () => { read.identified = null; }; },
} }));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (event: { name: string }, handler: () => void) => { read.events.set(event.name, handler); return () => read.events.delete(event.name); } },
}));

const paper: AccountProject = {
  chatId: 'chat-paper',
  name: 'Paper',
  archived: false,
  bindings: [
    { deviceId: 'gpu', localProjectId: 'gpu-paper' },
    { deviceId: 'this-computer', localProjectId: 'local-paper' },
    { deviceId: 'juma', localProjectId: 'juma-paper' },
    { deviceId: 'not-loaded', localProjectId: 'nl-paper' },
  ],
};
const empty: AccountProject = { chatId: 'chat-empty', name: 'Empty', archived: false, bindings: [] };

/** 项目表:本机一个、gpu(连着)一个、juma(离线,建得最早)一个;not-loaded 那台的项目不在表里。 */
function storeWith(projects: AccountProject[], local: { here?: boolean } = {}) {
  const store = new AccountProjectsStore();
  const table = new Map<string, { createdAt: string }>([
    ['gpu-paper', { createdAt: '2026-06-01' }],
    ['juma-paper', { createdAt: '2026-01-01' }],
    ...(local.here === false ? [] : [['local-paper', { createdAt: '2026-12-01' }] as const]),
  ]);
  const machineOf: Record<string, string> = { 'gpu-paper': 'gpu', 'juma-paper': 'juma' };
  store.attach({ projects: table, machineOf: (id) => machineOf[id] ?? null, connected: (deviceId) => deviceId === 'gpu' });
  runInAction(() => {
    store.list = projects;
    store.localDeviceId = 'this-computer';
    store.status = 'ready';
  });
  return store;
}

afterEach(() => {
  read.list.mockReset();
});

describe('accountProjectsStore helpers', () => {
  it('membersOf: bindings present in the project table, this computer first, then connected, then earliest', () => {
    const store = storeWith([paper, empty]);
    expect(store.membersOf('chat-paper')).toEqual(['local-paper', 'gpu-paper', 'juma-paper']);
    expect(store.representativeOf('chat-paper')).toBe('local-paper');
    expect(store.membersOf('chat-empty')).toEqual([]);
    expect(store.representativeOf('chat-empty')).toBeUndefined();
    expect(store.membersOf('chat-unknown')).toEqual([]);
  });

  it('without a folder on this computer the connected machine represents the project', () => {
    const store = storeWith([paper], { here: false });
    expect(store.membersOf('chat-paper')).toEqual(['gpu-paper', 'juma-paper']);
    expect(store.representativeOf('chat-paper')).toBe('gpu-paper');
  });

  it('a binding counts only on its own machine: a remote id that is local here, or the reverse, is not a member', () => {
    const store = storeWith([{ ...paper, bindings: [{ deviceId: 'gpu', localProjectId: 'local-paper' }, { deviceId: 'this-computer', localProjectId: 'gpu-paper' }] }]);
    expect(store.membersOf('chat-paper')).toEqual([]);
  });

  it('projectOfLocal: by the table machine, or by an explicit machine (null = this computer)', () => {
    const store = storeWith([paper, empty]);
    expect(store.projectOfLocal('local-paper')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('gpu-paper')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('nl-paper', 'not-loaded')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('local-paper', null)?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('local-paper', 'gpu')).toBeUndefined();
    expect(store.projectOfLocal('stray')).toBeUndefined();
  });
});

describe('accountProjectsStore reading', () => {
  it('reads the list and this computer, fails loud on error, and clear drops the account', async () => {
    const store = new AccountProjectsStore();
    expect(store.status).toBe('loading');
    read.list.mockResolvedValueOnce([paper]);
    await store.refresh();
    expect(store.status).toBe('ready');
    expect(store.localDeviceId).toBe('this-computer');
    expect(store.projects).toEqual([paper]);

    read.list.mockRejectedValueOnce(new Error('rpc down'));
    await store.refresh();
    expect(store.status).toBe('error');
    expect(store.error).toBe('rpc down');

    store.clear();
    expect(store.status).toBe('loading');
    expect(store.projects).toEqual([]);
    expect(store.localDeviceId).toBeNull();
  });

  // An offline reload: the list read fails, but which machine this is is this machine's own fact — its projects still
  // match their bindings (otherwise this computer's project rows turn into folderless group rows and reorder).
  it('knows this computer even when the first list read fails', async () => {
    const store = new AccountProjectsStore();
    read.list.mockRejectedValueOnce(new Error('fetch failed'));
    await store.refresh();
    expect(store.status).toBe('error');
    expect(store.localDeviceId).toBe('this-computer');
  });

  // owner asked whether the account list makes the client depend on the backend: reloading while it is unreachable keeps
  // the account's last list (marked by the read error), not an empty project section.
  it('a reload while the backend is unreachable starts from this account\'s last list and says the read failed', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    try {
      const before = new AccountProjectsStore();
      before.restore('user-a');
      read.list.mockResolvedValueOnce([paper, empty]);
      await before.refresh();

      const reloaded = new AccountProjectsStore();
      reloaded.restore('user-a');
      expect(reloaded.projects).toEqual([paper, empty]);
      expect(reloaded.status).toBe('loading');
      read.list.mockRejectedValueOnce(new Error('fetch failed'));
      await reloaded.refresh();
      expect(reloaded.status).toBe('error');
      expect(reloaded.projects).toEqual([paper, empty]);

      // Another account on this computer never sees it, and the previous account's copy is gone from this computer;
      // clear (sign-out) drops what is on screen.
      const other = new AccountProjectsStore();
      other.restore('user-b');
      expect(other.projects).toEqual([]);
      expect(storage.size).toBe(0);
      reloaded.clear();
      expect(reloaded.projects).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Nobody outside tells the store to read again: it subscribes to what changes the account's projects itself.
  it('start reads once, then again on a project revision, a removed device, this computer\'s publish and its identification', async () => {
    const store = new AccountProjectsStore();
    const revisions = new Map<string, (operations: readonly { payload: unknown }[]) => void>();
    const subscribe = ((event: string, listener: (operations: readonly { payload: unknown }[]) => void) => {
      revisions.set(event, listener);
      return () => revisions.delete(event);
    }) as unknown as Parameters<AccountProjectsStore['start']>[1];
    read.list.mockResolvedValue([paper]);
    const stop = store.start('user-a', subscribe);
    await vi.waitFor(() => expect(store.status).toBe('ready'));
    const readsAgain = async (signal: () => void, list: AccountProject[]) => {
      read.list.mockResolvedValueOnce(list);
      signal();
      await vi.waitFor(() => expect(store.projects).toEqual(list));
    };

    // A heartbeat (the device row only) is no project change.
    revisions.get('device_changed')!([{ payload: { device_id: 'gpu', kind: 'row', tombstone: false } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read.list).toHaveBeenCalledTimes(1);
    await readsAgain(() => revisions.get('device_changed')!([{ payload: { device_id: 'gpu', kind: 'projects', tombstone: false } }]), [empty]);
    await readsAgain(() => revisions.get('device_changed')!([{ payload: { device_id: 'gpu', kind: 'row', tombstone: true } }]), [paper]);
    // A project made here is in list_my_projects only once this machine's publish lands — that, not the creation.
    expect(read.events.has('project:created')).toBe(false);
    await readsAgain(() => read.events.get('project:device-projects-published')!(), [empty]);
    await readsAgain(() => read.identified!(), [paper]);
    expect(read.list).toHaveBeenCalledTimes(5);

    stop();
    expect(revisions.size).toBe(0);
    expect(read.events.size).toBe(0);
    expect(read.identified).toBeNull();
    // stop only unsubscribes: a moment without a signed-in user is not a sign-out.
    expect(store.projects).toEqual([paper]);
    // Another account signs in: the previous account's projects go before anything is read.
    read.list.mockImplementationOnce(() => new Promise(() => {}));
    store.start('user-b', subscribe);
    expect(store.projects).toEqual([]);
    expect(store.status).toBe('loading');
    // Its read lands in this test, not in the next one's mock.
    await vi.waitFor(() => expect(read.list).toHaveBeenCalledTimes(6));
  });

  it('a refresh asked for while reading reads again afterwards; a read that lands after clear is dropped', async () => {
    const store = new AccountProjectsStore();
    let resolveFirst!: (list: AccountProject[]) => void;
    read.list.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce([paper, empty]);
    const first = store.refresh();
    void store.refresh();
    await vi.waitFor(() => expect(read.list).toHaveBeenCalledTimes(1));
    resolveFirst([paper]);
    await first;
    await vi.waitFor(() => expect(store.projects).toEqual([paper, empty]));
    expect(read.list).toHaveBeenCalledTimes(2);

    let resolveLate!: (list: AccountProject[]) => void;
    read.list.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    const late = store.refresh();
    await vi.waitFor(() => expect(read.list).toHaveBeenCalledTimes(3));
    store.clear();
    resolveLate([empty]);
    await late;
    expect(store.projects).toEqual([]);
    expect(store.status).toBe('loading');
  });
});
