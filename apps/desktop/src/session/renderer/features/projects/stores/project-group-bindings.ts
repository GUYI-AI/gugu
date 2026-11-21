import { replica } from '@/lib/replica';
import { platform } from '@/platform';
import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';
import { projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';

/** 这台电脑,或能直接连那台机器的一端(桌面):本机进程的管道;手机经那台机器的会话页管道,只读不订。 */
const direct = (machine: string | null) => platform.capabilities.agentRuntime || machine === null;

/**
 * 一台机器上每个本地项目绑的项目群(那台机器自己的回答;`machine` null = 这台电脑)。项目群那一层(projectGroupsStore)
 * 与聊天列表认助理工作间(useAssistantWorkrooms)都读这一份,❌ 各自再问那台机器。
 */
export const projectGroupBindings = replica({
  name: 'projectGroupBindings',
  scope: 'account',
  networkMode: (machine) => (direct(machine) ? 'always' : 'online'),
  read: async (_owner: string, machine: string | null): Promise<ProjectGroupBinding[]> => {
    const rpc = direct(machine) ? rpcOn(machine) : (await import('@/components/session-watch/sessionpage-rpc')).machineRpc(machine!);
    const bound = await rpc.projects.listProjectGroupBindings();
    if (!bound.success) throw new Error(JSON.stringify(bound.error));
    return bound.data;
  },
  // Fed by the machine's change event where it is heard (Infinity), read on each show otherwise. Asked when read, ❌ at
  // module load (the platform is not a load-time dependency of everything importing the projects stores).
  get fresh() { return platform.capabilities.agentRuntime ? Infinity : 0; },
  watch: {
    group: (machine) => machine,
    start: (_owner, machine) => direct(machine)
      // reread, ❌ refresh: a reader that only holds the feed (projectGroupsStore) does not show the entry.
      ? onMachineEvent(machine, projectGroupBindingChangedChannel, () => { void projectGroupBindings.reread(machine).catch(() => undefined); })
      : () => undefined,
  },
});
