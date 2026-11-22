import { replica } from '@/lib/replica';
import { platform } from '@/platform';
import { foldersChangedChannel, type FolderRecord } from '@shared/core/folders/folders';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';

/** 这台电脑,或能直接连那台机器的一端(桌面):本机进程的管道;手机经那台机器的会话页管道,只读不订。 */
const direct = (machine: string | null) => platform.capabilities.agentRuntime || machine === null;

/**
 * 一台机器上挂在群上的文件夹(那台机器自己的回答;`machine` null = 这台电脑)。聊天列表认助理工作间(useAssistantWorkrooms)
 * 读这一份,❌ 再问那台机器一遍。
 */
export const machineGroupFolders = replica({
  name: 'machineGroupFolders',
  scope: 'account',
  networkMode: (machine) => (direct(machine) ? 'always' : 'online'),
  read: async (_owner: string, machine: string | null): Promise<FolderRecord[]> => {
    const rpc = direct(machine) ? rpcOn(machine) : (await import('@/components/session-watch/sessionpage-rpc')).machineRpc(machine!);
    return rpc.folders.listGroupFolders();
  },
  // Fed by the machine's change event where it is heard (Infinity), read on each show otherwise. Asked when read, ❌ at
  // module load (the platform is not a load-time dependency of everything importing the folder stores).
  get fresh() { return platform.capabilities.agentRuntime ? Infinity : 0; },
  watch: {
    group: (machine) => machine,
    start: (_owner, machine) => direct(machine)
      ? onMachineEvent(machine, foldersChangedChannel, () => { void machineGroupFolders.reread(machine).catch(() => undefined); })
      : () => undefined,
  },
});
