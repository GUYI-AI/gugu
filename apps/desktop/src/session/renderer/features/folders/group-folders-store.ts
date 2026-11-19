import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import type { AccountGroupFolders } from '@gugu/core/cloud/chatFolders';
import { foldersChangedChannel, type FolderRecord } from '@shared/core/folders/folders';
import { platform } from '@/platform';
import { readDeviceRevision, readRevisionResourceKey, type AccountRevisionEvent, type AccountRevisionListener } from '@/lib/accountRevisionCoordinator';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { onEachMachine, onMachineReconnected } from '@renderer/lib/machine-clients';
import { log } from '@renderer/utils/logger';

// @@@group-folders — which folders each group has on my machines. A group is the only container; a folder (a directory on
// one machine, its workspace id there) is an optional attribute of a group. Two sources, one answer:
//  · each machine's own list (rpc.folders.listAllFolders), read when it is connected and again when it says its folders
//    changed — what is true there now;
//  · the account's record (identity.my_chat_folders), which also holds machines that are offline now.
// A machine that has answered is read from its answer; one that has not (offline, too old, not yet) from the account's
// record, marked offline. Not here: the folder stores a session page mounts (the folder manager), the cards drawn from it.

/** A folder of a group on one of my machines. */
export type GroupFolder = {
  /** Its id on its machine (workspace id): the key its sessions, git state and settings carry. */
  id: string;
  path: string;
  chatId: string;
  /** The machine it is on: null = this computer. */
  deviceId: string | null;
  /** Its place among the group's folders on that machine (1 = where a new task starts by default). */
  sort: number;
  /** null = not known (the account's record does not say). */
  gitless: boolean | null;
  branch: string | null;
  sessionIds: readonly string[];
  attachedAt: string | null;
  /** The machine has not answered: this is the account's record. */
  offline: boolean;
};

export type GroupWithFolders = {
  chatId: string;
  /** The group's own name (the account's record); '' before that is read. */
  name: string;
  /** The group's last activity (ISO); null = not read yet. */
  activeAt: string | null;
  folders: readonly GroupFolder[];
};

export type GroupFoldersStatus = 'loading' | 'ready' | 'error';

/** The account's revision feed (the chat layer gives it, store/chatContext). */
export type SubscribeAccountRevision = (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void;

/** This computer's key among the machines' answers. */
const HERE = '';
const keyOf = (deviceId: string | null) => deviceId ?? HERE;

/** A folder's name on a card: the last segment of its path (a folder has no name of its own). */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed;
}

const byPlace = (a: GroupFolder, b: GroupFolder) =>
  (a.deviceId === null ? 0 : 1) - (b.deviceId === null ? 0 : 1)
  || (a.deviceId ?? '').localeCompare(b.deviceId ?? '')
  || a.sort - b.sort
  || a.id.localeCompare(b.id);

export class GroupFoldersStore {
  /** The account's record; kept from the last read when a read fails (status 'error' says so). */
  account: readonly AccountGroupFolders[] = [];
  status: GroupFoldersStatus = 'loading';
  error: string | null = null;
  /** This computer's device id (the account's record names machines by it); null = not known (the phone). */
  localDeviceId: string | null = null;
  /** Each machine's own answer (all its folders, bound or not), by machine; '' = this computer. */
  readonly answers = observable.map<string, readonly FolderRecord[]>([], { deep: false });
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopMachines: (() => void) | null = null;

  constructor() {
    makeObservable<GroupFoldersStore, 'byGroup'>(this, {
      account: observable.ref,
      status: observable,
      error: observable,
      localDeviceId: observable,
      // Kept alive: components read `groups` through useSyncExternalStore, which needs the same array until it changes.
      byGroup: computed({ keepAlive: true }),
      groups: computed({ keepAlive: true }),
    });
  }

  /**
   * Who is signed in: read the account's record now and whenever a machine's folders or a group's name or state change in
   * the account. The returned stop only unsubscribes; signing out is {@link clear}.
   */
  start(subscribeRevision: SubscribeAccountRevision): () => void {
    void this.refresh();
    const offs = [
      subscribeRevision('device_changed', (operations) => {
        if (operations.some((operation) => {
          const key = readDeviceRevision(operation.payload);
          return key.projects || key.removed;
        })) void this.refresh();
      }),
      subscribeRevision('chat_meta_changed', (operations) => {
        if (operations.some((operation) => {
          const key = readRevisionResourceKey(operation.payload, 'chat_meta_changed');
          return key.entityId !== null && this.byGroup.has(key.chatId);
        })) void this.refresh();
      }),
      platform.subscribeLocalDeviceIdentified?.(() => void this.refresh()) ?? (() => {}),
    ];
    return () => offs.forEach((off) => off());
  }

  /**
   * Read each machine's own list: this computer now, every machine when its link opens or reopens, and again whenever it
   * says its folders changed. Idempotent. The desktop's session page calls it; the phone has no machine links.
   */
  watchMachines(): void {
    if (this.stopMachines) return;
    void this.readMachine(null);
    const offHere = onMachineEvent(null, foldersChangedChannel, () => {
      void this.readMachine(null);
      void this.refresh();
    });
    const offMachines = onEachMachine((deviceId) => {
      void this.readMachine(deviceId);
      const offs = [
        onMachineReconnected(deviceId, () => void this.readMachine(deviceId)),
        (() => {
          try {
            return onMachineEvent(deviceId, foldersChangedChannel, () => void this.readMachine(deviceId));
          } catch (error) {
            // No link to that machine now: there is nothing to subscribe to; its reconnect reads it again.
            log.warn('[group-folders] cannot follow this machine\'s folders', { deviceId, error });
            return () => {};
          }
        })(),
      ];
      return () => offs.forEach((off) => off());
    });
    this.stopMachines = () => {
      offHere();
      offMachines();
    };
  }

  /** One machine's answer, replacing the last; an unanswered read leaves that machine on the account's record. */
  async readMachine(deviceId: string | null): Promise<void> {
    const generation = this.generation;
    try {
      const folders = await rpcOn(deviceId).folders.listAllFolders();
      if (generation !== this.generation) return;
      runInAction(() => this.answers.set(keyOf(deviceId), folders));
    } catch (error) {
      log.warn('[group-folders] a machine did not answer with its folders', { deviceId, error: String(error) });
      if (generation === this.generation) runInAction(() => this.answers.delete(keyOf(deviceId)));
    }
  }

  /** Read the account's record once; asked again while reading = read again after this one (❌ swallowed). */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const generation = this.generation;
    const self = Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then((snapshot) => {
      if (generation === this.generation && snapshot?.device_id) runInAction(() => { this.localDeviceId = snapshot.device_id; });
    }, (error: unknown) => log.warn('[group-folders] this computer\'s device id could not be read', error));
    const read = import('@/lib/chatFolders').then((cloud) => cloud.listMyGroupFolders())
      .then((list) => {
        if (generation !== this.generation) return;
        runInAction(() => {
          this.account = list;
          this.status = 'ready';
          this.error = null;
        });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        log.error('[group-folders] the account\'s group folders could not be read', error);
        runInAction(() => {
          this.status = 'error';
          this.error = error instanceof Error ? error.message : String(error);
        });
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    const both = Promise.all([self, read]).then(() => undefined);
    this.inFlight = both;
    return both;
  }

  /** Sign-out / switching accounts: nothing of the last account stays, and reads in flight land nowhere. */
  clear(): void {
    this.generation += 1;
    this.inFlight = null;
    this.again = false;
    runInAction(() => {
      this.account = [];
      this.status = 'loading';
      this.error = null;
      this.localDeviceId = null;
      this.answers.clear();
    });
  }

  /** Tell a component that is not an observer when the groups change (useSyncExternalStore with `groups`). */
  readonly subscribe = (listener: () => void): (() => void) => reaction(() => [this.groups, this.status] as const, listener);

  /** Every group with a folder on one of my machines, by group. */
  private get byGroup(): ReadonlyMap<string, GroupWithFolders> {
    const out = new Map<string, { chatId: string; name: string; activeAt: string | null; folders: GroupFolder[] }>();
    const groupOf = (chatId: string) => {
      let group = out.get(chatId);
      if (!group) {
        group = { chatId, name: '', activeAt: null, folders: [] };
        out.set(chatId, group);
      }
      return group;
    };
    for (const [key, folders] of this.answers) {
      const deviceId = key === HERE ? null : key;
      for (const folder of folders) {
        if (!folder.chatId) continue;
        groupOf(folder.chatId).folders.push({
          id: folder.id, path: folder.path, chatId: folder.chatId, deviceId, sort: folder.sort ?? 0, gitless: folder.gitless,
          branch: folder.branch, sessionIds: folder.sessionIds, attachedAt: folder.attachedAt, offline: false,
        });
      }
    }
    for (const group of this.account) {
      if (group.archived) {
        out.delete(group.chatId);
        continue;
      }
      const shown = groupOf(group.chatId);
      shown.name = group.name;
      shown.activeAt = group.activeAt;
      for (const folder of group.folders) {
        if (folder.removalRequestedAt) continue;
        const deviceId = folder.deviceId === this.localDeviceId ? null : folder.deviceId;
        // A machine that answered is read from its answer (❌ the account's older copy beside it).
        if (this.answers.has(keyOf(deviceId))) continue;
        shown.folders.push({
          id: folder.folderId, path: folder.path, chatId: group.chatId, deviceId, sort: folder.position, gitless: null,
          branch: null, sessionIds: [], attachedAt: folder.attachedAt, offline: true,
        });
      }
    }
    for (const [chatId, group] of out) {
      if (group.folders.length === 0) out.delete(chatId);
      else group.folders.sort(byPlace);
    }
    return out;
  }

  /** The groups with a folder on my machines, most recent activity first. */
  get groups(): readonly GroupWithFolders[] {
    return [...this.byGroup.values()].sort((a, b) => (b.activeAt ?? '').localeCompare(a.activeAt ?? ''));
  }

  /** A group's folders on my machines (this computer first, then each machine by its order); none = []. */
  foldersOf(chatId: string): readonly GroupFolder[] {
    return this.byGroup.get(chatId)?.folders ?? [];
  }

  /** The group a folder is bound to (by its id on its machine); none = null. */
  chatOfFolder(folderId: string): string | null {
    for (const folders of this.answers.values()) {
      const found = folders.find((folder) => folder.id === folderId);
      if (found) return found.chatId;
    }
    for (const group of this.account) if (group.folders.some((folder) => folder.folderId === folderId)) return group.chatId;
    return null;
  }
}

export const groupFoldersStore = new GroupFoldersStore();
