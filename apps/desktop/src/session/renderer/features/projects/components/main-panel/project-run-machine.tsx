import { useState, useSyncExternalStore } from 'react';
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store';
import { log } from '@renderer/utils/logger';
import type { GroupFoldersState } from '@renderer/features/folders/group-folders';

/**
 * 群里的新任务在哪台机器上跑(群与机器解耦):机器只是这一次跑在哪里、用哪个文件夹。
 * 一次只选一台;记的是人上次在这个群里选的那台,记在账号上(agentCreateDefaults.machineByProject,
 * 键 = 群 chatId;值 = 设备 id),手机与别的桌面共用这一份。
 */
export const scopeKey = (deviceId: string | null) => deviceId ?? 'local';
export const machineOfKey = (key: string): string | null => (key === 'local' ? null : key);

/**
 * 账号上那份「每个群上次在哪台」(群 chatId → 设备 id)。有选择器挂上就读一次(同一时刻只读一次):开着的桌面再打开
 * 一个群时看得到手机 / 别的桌面后来的选择;读失败下次挂上再读。账号设置没有 revision 可订,❌ 按时间轮询。
 * 这一端选了、账号上还没写好的那几个(pending)以这一端为准,❌ 被刚读回来的旧值盖掉。
 * 这台电脑是哪个设备 id 认 groupFoldersStore.localDeviceId(同一份,❌ 这里再问一遍)。
 */
const memory = {
  byProject: {} as Record<string, string>,
  pending: new Map<string, string>(),
  reading: false,
};
const listeners = new Set<() => void>();
/** 进群时带进来、还没记上账号的机器(群 → scopeKey),见 carryRunMachine。 */
const carried = new Map<string, string>();
let snapshot: Readonly<Record<string, string>> = {};

function publish(): void {
  snapshot = { ...memory.byProject };
  for (const listener of listeners) listener();
}

function read(): void {
  if (memory.reading) return;
  memory.reading = true;
  // 按需取账号那一层(它带着云端客户端,不在模块加载时拉进来)。
  void import('@/lib/agentCreateDefaults')
    .then((cloud) => cloud.readAgentCreateDefaults())
    .then((defaults) => {
      memory.byProject = { ...defaults.machineByProject, ...Object.fromEntries(memory.pending) };
      publish();
    })
    .catch((error: unknown) => log.warn('[group-folders] read the machine each group last ran on failed', error))
    .finally(() => { memory.reading = false; });
}

function subscribe(listener: () => void): () => void {
  read();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 选择器读的那一份(useSyncExternalStore 的两端;值是设备 id);单独导出给测试。 */
export const runMachineMemory = { subscribe, current: (): Readonly<Record<string, string>> => snapshot };

/** 记下这个群这次选在哪台(null = 这台电脑):这一端立刻生效,账号上那份随后写上。 */
export function rememberRunMachine(groupId: string | undefined, deviceId: string | null): void {
  if (!groupId) return;
  const projectKey = groupId;
  const device = deviceId ?? groupFoldersStore.localDeviceId;
  if (!device) {
    log.warn('[group-folders] this computer has no device id yet; the machine choice is not remembered', { projectKey });
    return;
  }
  memory.pending.set(projectKey, device);
  memory.byProject = { ...memory.byProject, [projectKey]: device };
  publish();
  void import('@/lib/agentCreateDefaults')
    .then((cloud) => cloud.rememberAgentCreateRunMachine(projectKey, device))
    .catch((error: unknown) => log.warn('[group-folders] remember the machine a group ran on failed', error))
    .finally(() => { if (memory.pending.get(projectKey) === device) memory.pending.delete(projectKey); });
}

/** 测试用:清掉这一端的记忆和带进来的机器。 */
export function resetRunMachineMemoryForTest(): void {
  memory.byProject = {};
  memory.pending.clear();
  memory.reading = false;
  carried.clear();
  snapshot = {};
}

/** 有这个群的文件夹的一台机器(`key` 同 scopeKey;本机在前)。 */
export type RunMachineCandidate = { key: string; online: boolean };

/**
 * 默认在哪台跑(DESIGN「新建任务」):上次选的那台且它在线 → 本机(有文件夹)→ 有文件夹的在线机器里排最前的 →
 * 都不在线时才回到上次选的那台 → 第一台。❌ 换到一台没有文件夹的机器上。没有任何文件夹 = null。
 */
export function defaultRunMachine(candidates: readonly RunMachineCandidate[], saved: string | undefined): string | null {
  const savedOne = saved ? candidates.find((machine) => machine.key === saved) : undefined;
  if (savedOne?.online) return savedOne.key;
  if (candidates.some((machine) => machine.key === 'local')) return 'local';
  const online = candidates.find((machine) => machine.online);
  if (online) return online.key;
  return savedOne?.key ?? candidates[0]?.key ?? null;
}

/**
 * 进群时带进来的机器(新建任务页上先选了机器、再选群,`projectKey` = 群):这个窗口里这个群先选它,
 * ❌ 写进账号 —— 只是把一台机器交给接下来打开的群页;在它上面真建了任务才记(useProjectRunMachine 的 created)。
 * 人在选择器里另选一台 = 不再带着。
 */
export function carryRunMachine(projectKey: string, deviceId: string | null): void {
  carried.set(projectKey, scopeKey(deviceId));
  publish();
}

/**
 * 这个群此刻选着的机器。`projectKey` 分开这一页上的不同群;`groupId` = 记在账号上的那个键(没有 = 不记、也不读记忆)。`pick` = 人选的(记下来,下次默认还是它);候选里没有它(没有文件夹)也照选 ——
 * 那是人刚在那台机器上挂了文件夹、文件夹清单还没读回来。
 */
export function useProjectRunMachine(projectKey: string, candidates: readonly RunMachineCandidate[], groupId: string | undefined) {
  const saved = useSyncExternalStore(runMachineMemory.subscribe, runMachineMemory.current);
  const savedDevice = groupId ? saved[groupId] : undefined;
  const [picked, setPicked] = useState<{ projectKey: string; key: string } | null>(null);
  const carriedKey = carried.get(projectKey);
  const chosen = picked && picked.projectKey === projectKey
    ? picked.key
    : carriedKey ?? defaultRunMachine(candidates, savedDevice && savedDevice === groupFoldersStore.localDeviceId ? scopeKey(null) : savedDevice);
  const pick = (deviceId: string | null) => {
    carried.delete(projectKey);
    setPicked({ projectKey, key: scopeKey(deviceId) });
    rememberRunMachine(groupId, deviceId);
  };
  /** 在选着的这台上真建了任务(新建框的 onSessionCreated):带进来的那台到这时才记上账号。 */
  const created = () => {
    if (carriedKey === undefined || carriedKey !== chosen) return;
    carried.delete(projectKey);
    rememberRunMachine(groupId, machineOfKey(carriedKey));
  };
  return { selected: chosen ? [chosen] : [], machine: chosen === null ? undefined : machineOfKey(chosen), pick, created };
}

/** The folders on the machines selected; a selected cloud machine that is resting has not answered yet = still reading. */
export function foldersInScope(
  state: GroupFoldersState,
  selected: readonly string[],
  isDeviceResting: (deviceId: string) => boolean = () => false,
): GroupFoldersState {
  const found = state.folders?.filter((folder) => selected.includes(scopeKey(folder.deviceId))) ?? null;
  // A resting cloud device has not answered this read; its empty cached list is not proof that the selected folders are
  // unavailable. Typing wakes it via the existing composer path, and reconnecting reloads the actual folder list.
  const waiting = selected.some((deviceId) => deviceId !== 'local' && isDeviceResting(deviceId));
  const folders = found?.length === 0 && waiting ? null : found;
  const chosen = folders?.find((folder) => folder.id === state.chosen?.id) ?? folders?.[0] ?? null;
  return { ...state, folders, chosen };
}
