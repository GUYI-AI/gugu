import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { replica, useReplica, useReplicas, type Reading } from '@/lib/replica';
import type { AttachProjectFolderError, ProjectFolder } from '@shared/core/projects/project-folders';
import { projectFoldersChangedChannel, projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';

/**
 * 项目首页的文件夹卡与输入框的文件夹选择器共用的数据(product spec「项目首页」,#7341)。
 * 项目首页读一次、往下传:❌ 两处各读一遍。
 *
 * 一个项目可以在几台机器上各有一个本地项目(绑在同一个项目群上,#7341 第二步):这里把它们的文件夹汇总成一份。
 * 每个本地项目的文件夹由它所在的那台机器回答(rpc 按 projectId 自动路由,lib/ipc.ts)。
 * 那台机器此刻答不上(离线)时,用账号上记着的那份(#113)、标离线 —— 机器离线时它的文件夹照样列在项目里(product spec)。
 */

/**
 * 卡片上的一个文件夹:多两格 —— 「那台机器此刻答不上,这是账号上记着的」,与它在哪台机器上(`deviceId`,null = 这台电脑)。
 * 机器在读的那一刻按「是哪台答的 / 账号上那份是哪台记的」盖上,用的地方都读它(机器标签、设备范围、在哪台上开工),
 * ❌ 再拿 folder.projectId 去反查 —— 同一个本地项目 id 可能先后登记在两条设备行下(同一台机器重新登记)。
 */
export type ShownFolder = ProjectFolder & {
  offline: boolean;
  deviceId: string | null;
  stale?: boolean;
  /** A paper held for a folder of a machine not answered yet (the last run's count): no name, no menu, same size. */
  placeholder?: true;
};

/** 每个项目(按代表那一行的 id)「新会话从哪个文件夹开工」:切走再回来还在;没选过 = 代表行的根目录。 */
const folderChoice = new Map<string, string>();
/** 刚挂上的文件夹(这一页里标「刚挂上」、排在最前)。 */
const freshFolders = new Map<string, string>();

/** 一台机器这么久还没答(掉线了、连接还没断开):先列账号上记着的、标离线。 */
export const UNANSWERED_AFTER_MS = 3000;

/** 一个项目最多挂多少个文件夹(含根目录,各台机器合计;owner 2026-10-27:再多就奇怪了)。 */
export const MAX_PROJECT_FOLDERS = 20;

/** 账号上记着的这个本地项目的文件夹(本机的项目 / 还没读到过账号上的那份 = null)。 */
function accountFolders(projectId: string): ProjectFolder[] | null {
  const machine = machineRegistry.machineOf(projectId);
  return machine ? remoteHostsStore.accountFolders(machine, projectId) : null;
}

/** 账号上那份这一端上一次没读到(列着的是更早读到的):卡上标「上次的」。 */
function accountUnread(projectId: string): boolean {
  const machine = machineRegistry.machineOf(projectId);
  return machine ? remoteHostsStore.accountUnread(machine) : false;
}

/** 账号上那份比这一端经连接读到的新(见 RemoteHostsStore.accountIsNewer);本机的项目 = false。 */
function accountIsNewer(projectId: string): boolean {
  const machine = machineRegistry.machineOf(projectId);
  return machine ? remoteHostsStore.accountIsNewer(machine) : false;
}

export function chosenFolderOf(rowId: string, folders: readonly ShownFolder[] | null): ShownFolder | null {
  const real = folders?.filter((folder) => !folder.placeholder) ?? [];
  if (real.length === 0) return null;
  const chosen = folderChoice.get(rowId);
  const picked = real.find((folder) => folder.workspaceId === chosen);
  if (picked) return picked;
  // The row's own machine not answered yet: nothing is chosen (❌ "the first root that arrived").
  if (folders?.some((folder) => folder.placeholder && folder.projectId === rowId)) return null;
  return (
    real.find((folder) => folder.kind === 'root' && folder.projectId === rowId) ??
    real.find((folder) => folder.kind === 'root') ??
    real[0]
  );
}

export type AttachResult =
  | { ok: true; folder: ProjectFolder }
  | { ok: false; error: AttachProjectFolderError | { type: 'rpc-failed'; message: string } };

export type ProjectFoldersState = {
  folders: ShownFolder[] | null;
  /** 一台都读不到、账号上也没有:卡片如实说读不到(原因进日志),❌ 拿根目录冒充全部。 */
  loadError: boolean;
  /** 这一行里还没答过的本地项目(那台机器的文件夹还不知道,❌ 当成没有)。 */
  unanswered: readonly string[];
  chosen: ShownFolder | null;
  /** 刚挂上的那一个(workspaceId)。 */
  fresh: string | undefined;
  choose: (workspaceId: string) => void;
  reload: () => void;
  /** 挂到这个项目在某台机器上的那个本地项目(projectId)下。 */
  attach: (projectId: string, path: string) => Promise<AttachResult>;
  detach: (folder: ProjectFolder) => Promise<boolean>;
};

/**
 * One local project's folders, as its machine answers (rpc routes by projectId). Drawn in member order, ❌ in the order
 * machines answer (new-agent cards went 3 → 6 and reordered). Push-fed by each member's machine (one subscription per
 * machine while its folders are shown); folders read while nobody listened (back on the home page) are read again then.
 */
export const projectFolders = replica({
  name: 'projectFolders',
  scope: 'account',
  read: async (_owner, projectId: string): Promise<ProjectFolder[]> => {
    const result = await rpc.projects.listProjectFolders(projectId);
    if (!result.success) throw new Error(result.error.message ?? `listing the folders of ${projectId} failed`, { cause: result.error });
    return result.data;
  },
  fresh: Infinity,
  watch: {
    group: (projectId) => machineRegistry.machineOf(projectId) ?? null,
    start: (_owner, projectId) => {
      const machine = machineRegistry.machineOf(projectId) ?? null;
      const offs = [
        onMachineEvent(machine, projectFoldersChangedChannel, ({ projectId: changed }) => { void projectFolders.refresh(changed); }),
        // Another machine's copy joined or left the project's group: its folders are read again with the rest.
        onMachineEvent(machine, projectGroupBindingChangedChannel, () => { void projectFolders.refresh(); }),
      ];
      return () => offs.forEach((off) => off());
    },
  },
});

/**
 * How many folders each member machine showed last (member order), kept across restarts so the first open draws every
 * paper at once. Keyed by row and a hash of its members. Written as the folders settle, never read.
 */
export const projectFolderLayout = replica({
  name: 'projectFolderLayout',
  scope: 'account',
  read: async (_owner, _rowId: string, _members: string): Promise<(number | null)[]> => {
    throw new Error('a folder layout is written as folders settle, never read');
  },
  fresh: Infinity,
  persist: { maxBytes: 320, maxEntries: 8 },
});

function membersHash(memberIds: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of memberIds.join('\u0000')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16);
}

/**
 * @param rowId 代表这个项目的那一行(侧栏那一行)的本地项目 id
 * @param memberIds 这个项目在各台机器上的本地项目(含 rowId;没合并就只有它)
 */
export function useProjectFolders(rowId: string, memberIds: readonly string[] = [rowId]): ProjectFoldersState {
  const membersKey = memberIds.join('\u0000');
  const members = useMemo(() => [...new Set(membersKey.split('\u0000'))], [membersKey]);
  const readings = useReplicas(projectFolders, members.map((id) => [id] as [string]));
  const layoutArgs: [string, string] = [rowId, membersHash(members)];
  const layout = useReplica(projectFolderLayout, layoutArgs, { read: false });
  const [fresh, setFresh] = useState<string | undefined>(() => freshFolders.get(rowId));
  const [late, setLate] = useState(false);
  // A read asked now (a reload, a machine reconnecting) restarts the wait for machines that do not answer.
  const [asked, setAsked] = useState(0);
  const askAgain = useCallback((ids: readonly string[]) => {
    setAsked((n) => n + 1);
    for (const id of ids) void projectFolders.refresh(id);
  }, []);

  // A machine whose connection comes back, or whose account record changed while away, is asked again.
  // 读的是 mobx 里的设备行 —— 项目首页是 observer,那一份变了这里才重算。
  const connectionKey = JSON.stringify(members.map((projectId) => {
    const deviceId = machineRegistry.machineOf(projectId);
    return [deviceId, deviceId ? remoteHostsStore.connectionState(deviceId) === 'connected' : true,
      accountFolders(projectId)?.length ?? null, accountIsNewer(projectId), accountUnread(projectId)];
  }));
  const firstConnection = useRef(connectionKey);
  useEffect(() => {
    if (firstConnection.current === connectionKey) return;
    firstConnection.current = connectionKey;
    askAgain(members);
  }, [connectionKey, members, askAgain]);

  // A machine that has not answered after a while and has nothing else to show: draw without it.
  useEffect(() => {
    setLate(false);
    const deadline = setTimeout(() => setLate(true), UNANSWERED_AFTER_MS);
    return () => clearTimeout(deadline);
  }, [rowId, membersKey, asked]);

  // 换了项目:「刚挂上」跟着换成那个项目的(❌ 把上一个项目的那张带过来)。
  useEffect(() => setFresh(freshFolders.get(rowId)), [rowId]);

  const lists = members.map((projectId, index) => memberFolders(projectId, readings[index]!, layout, index, late));
  const waiting = lists.some((list) => list === 'waiting');
  const known = lists.filter((list): list is ShownFolder[] => Array.isArray(list));
  // Machines still to answer this read: not answered yet, or asked again after an empty answer (an empty answer belongs
  // to the connection that gave it: a waking machine's "none" is not the new connection's answer).
  const unanswered = late ? [] : members.filter((_id, index) => {
    const reading = readings[index]!;
    return reading.state === 'unknown' || (reading.state === 'value' && reading.stale && !reading.error && reading.value.length === 0);
  });
  const merged = known.flat();
  const folders = waiting || known.length === 0 || (merged.length === 0 && unanswered.length > 0) ? null : merged;
  const loadError = !waiting && known.length === 0 && lists.every((list) => list === 'nothing');

  // What each machine answered: the count of each is what the next start draws first; a folder that appears in a
  // member's answer it did not have before (attached in another window, by an agent, undone) is the fresh one.
  const answered = readings.map((reading) => (reading.state === 'value' ? reading.value : null));
  const seen = useRef<{ rowId: string; members: (ProjectFolder[] | null)[] } | null>(null);
  useEffect(() => {
    const before = seen.current?.rowId === rowId ? seen.current.members : null;
    seen.current = { rowId, members: answered };
    // Each machine that answered gives its count; one that has not keeps its old count (❌ blocking the others' write).
    if (answered.some((list) => list !== null)) {
      const stored = layout.state === 'value' ? layout.value : null;
      const counts = answered.map((list, index) => (list ? list.length : stored?.[index] ?? null));
      if (!stored || stored.join() !== counts.join()) projectFolderLayout.set(layoutArgs, counts);
    }
    if (!before) return;
    const added = answered.flatMap((list, index) => {
      const previous = before[index];
      if (!list || !previous) return [];
      const had = new Set(previous.map((folder) => folder.workspaceId));
      return list.filter((folder) => !had.has(folder.workspaceId));
    });
    const newest = added.sort((a, b) => (b.attachedAt ?? '').localeCompare(a.attachedAt ?? ''))[0];
    if (newest) {
      freshFolders.set(rowId, newest.workspaceId);
      setFresh(newest.workspaceId);
    }
  });

  // The choice lives in the module (it outlives a remount); a choice made redraws the card and the composer.
  const [, setChoice] = useState(0);
  const choose = useCallback(
    (workspaceId: string) => {
      folderChoice.set(rowId, workspaceId);
      setChoice((n) => n + 1);
    },
    [rowId]
  );

  const attach = useCallback(
    async (projectId: string, path: string): Promise<AttachResult> => {
      const ownerId = cachedDevicesAccount();
      try {
        const result = await rpc.projects.attachProjectFolder(projectId, path);
        if (!result.success) return { ok: false, error: result.error };
        void reportAssistantAppChange({ rpc }, undefined, { resource: 'projects', operation: 'edited', section: 'folders', id: projectId,
          deviceId: machineRegistry.machineOf(projectId) ?? undefined, after: { path: result.data.path } }, ownerId);
        freshFolders.set(rowId, result.data.workspaceId);
        setFresh(result.data.workspaceId);
        await Promise.all([...new Set([projectId, ...members])].map((id) => projectFolders.refresh(id)));
        return { ok: true, folder: result.data };
      } catch (error) {
        return { ok: false, error: { type: 'rpc-failed', message: error instanceof Error ? error.message : String(error) } };
      }
    },
    [rowId, members]
  );

  const detach = useCallback(
    async (folder: ProjectFolder): Promise<boolean> => {
      const ownerId = cachedDevicesAccount();
      const result = await rpc.projects.detachProjectFolder(folder.projectId, folder.workspaceId);
      if (!result.success) throw new Error(result.error.message, { cause: result.error });
      void reportAssistantAppChange({ rpc }, undefined, { resource: 'projects', operation: 'edited', section: 'folders', id: folder.projectId,
        deviceId: machineRegistry.machineOf(folder.projectId) ?? undefined, before: { path: folder.path } }, ownerId);
      if (freshFolders.get(rowId) === folder.workspaceId) {
        freshFolders.delete(rowId);
        setFresh(undefined);
      }
      if (folderChoice.get(rowId) === folder.workspaceId) folderChoice.delete(rowId);
      await Promise.all([...new Set([folder.projectId, ...members])].map((id) => projectFolders.refresh(id)));
      return true;
    },
    [rowId, members]
  );

  return {
    folders,
    loadError,
    unanswered,
    chosen: chosenFolderOf(rowId, folders),
    fresh,
    choose,
    reload: () => askAgain(members),
    attach,
    detach,
  };
}

/**
 * One machine's part of the card. Its answer when there is one. When its last read failed or it has not answered yet:
 * the account's record of its folders (marked offline; the newer of the record and the last answer). With neither: the
 * last run's count as placeholder papers; with nothing at all, wait — until the deadline, then draw without it.
 */
function memberFolders(
  projectId: string,
  reading: Reading<ProjectFolder[]>,
  layout: Reading<(number | null)[]>,
  index: number,
  late: boolean,
): ShownFolder[] | 'waiting' | 'nothing' {
  const deviceId = machineRegistry.machineOf(projectId) ?? null;
  const live = (list: ProjectFolder[]) => list.map((folder): ShownFolder => ({ ...folder, offline: false, deviceId }));
  // The account's record of the machine's folders. Marked offline only once the machine is known not to answer (its
  // read failed, or the deadline passed): before that, whether it is online is the machine's own state, ❌ "offline".
  const recordedAs = (offline: boolean) => accountFolders(projectId)?.map((folder): ShownFolder => ({
    ...folder, offline, deviceId, ...(accountUnread(projectId) ? { stale: true as const } : {}),
  })) ?? null;
  const recorded = recordedAs(true);
  // Asked again and not answered past the deadline: what it last answered, now marked offline.
  if (reading.state === 'value' && !reading.error && !(reading.stale && late)) return live(reading.value);
  if (reading.state === 'value') {
    const last = reading.value.map((folder): ShownFolder => ({ ...folder, offline: true, deviceId }));
    return accountIsNewer(projectId) ? recorded ?? last : last;
  }
  if (reading.state === 'error') return recorded ?? 'nothing';
  const waitingOnRecord = recordedAs(late);
  if (waitingOnRecord) return waitingOnRecord;
  const count = layout.state === 'value' ? layout.value[index] : null;
  if (typeof count === 'number') {
    return Array.from({ length: count }, (_, n): ShownFolder => ({
      workspaceId: `pending:${projectId}:${n}`, projectId, kind: n === 0 ? 'root' : 'attached', path: '' as ProjectFolder['path'],
      branch: null, sessionIds: [], attachedAt: null, offline: false, deviceId, placeholder: true,
    }));
  }
  return late ? 'nothing' : 'waiting';
}
