import { comparer, observable, reaction, runInAction } from 'mobx';
import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';
import { projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { events, onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { onEachMachine } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { publishProjectGroupChats } from './project-group-chats-bridge';

/**
 * 每个本地项目绑的项目群(这台电脑 + 每台连着的机器各自回答),#7341 第二步。
 * 群操作(绑定 / 解绑 / 建群)和聊天页上哪些群是项目群读它;有哪些项目、一个本地项目归哪个项目群一律读 accountProjectsStore,
 * ❌ 在这里再答一遍(两份答案在发布落到账号之前会不一样)。
 *
 * 没连着的机器(离线、太旧):那台的绑定照账号上记着的那份(#113,由远程主机那边交进来,见 applyBindings)——
 * 离线机器上的项目照样并在原来那一行里(product spec:机器离线时文件夹照样列在项目里),❌ 一掉线就拆成单独一行。
 */
export class ProjectGroupsStore {
  private readonly byProject = observable.map<string, string>();
  private stop: (() => void) | null = null;
  /** 此刻连着、项目清单同步过的机器(由远程主机那边给;❌ 在这里 import 它 —— 那边反过来要用这里)。 */
  private syncedMachines: () => readonly string[] = () => [];
  private projectRows: () => readonly string[] = () => [];

  /** 项目页实际渲染的代表行;聊天列表、打开群和快捷搜索都认这一份关系。 */
  private get projectsByChat(): ReadonlyMap<string, string> {
    const rows = new Map<string, string>();
    for (const projectId of this.projectRows()) {
      const chatId = this.byProject.get(projectId);
      if (chatId) rows.set(chatId, projectId);
    }
    return rows;
  }

  /** 这个群绑定的一个项目,不受项目行显隐影响(成员权限等按绑定判断)。 */
  projectOfChat(chatId: string): string | undefined {
    for (const [projectId, bound] of this.byProject) if (bound === chatId) return projectId;
    return undefined;
  }

  /** 这个群在项目页上的代表行;没有行就从聊天列表打开。 */
  rowProjectOfChat(chatId: string): string | undefined {
    return this.projectsByChat.get(chatId);
  }

  /** 会话页挂上时由远程主机那边调一次(它知道哪些机器连着)。重复调用无害。 */
  start(syncedMachines: () => readonly string[], agentSessions: () => readonly { projectId: string; sessionId: string; agentUserId: string | null | undefined }[], projectRows: () => readonly string[]): void {
    this.syncedMachines = syncedMachines;
    this.projectRows = projectRows;
    if (!this.stop) {
      void this.refresh(null);
      // 连上(且项目清单同步过)的机器各读一次;之后再连上一次就再读一次。
      const offHosts = reaction(
        () => this.syncedMachines().join('\u0000'),
        (joined) => {
          for (const deviceId of joined ? joined.split('\u0000') : []) void this.refresh(deviceId);
        },
        { fireImmediately: true }
      );
      // 哪台机器上的绑定变了(并进来、撤销、agent 挂的):在那台机器上订,就重读那一台。
      // 账号上的项目不在这里重读:绑定要等那台机器发布到账号才进 list_my_projects,它自己订着那一下(accountProjectsStore.start)。
      const offLocal = events.on(projectGroupBindingChangedChannel, () => void this.refresh(null));
      const offMachines = onEachMachine((deviceId) =>
        onMachineEvent(deviceId, projectGroupBindingChangedChannel, () => void this.refresh(deviceId))
      );
      // 只有项目页确实有行的群才从聊天页拿掉;绑定还在但项目已隐藏的群仍在聊天页。
      const offPublish = reaction(
        () => {
          const chatIds = [...this.projectsByChat.keys()].sort();
          const byChat = new Map<string, Set<string>>([...this.byProject.values()].map((chatId) => [chatId, new Set<string>()]));
          for (const session of agentSessions()) {
            const chatId = this.byProject.get(session.projectId);
            if (chatId && session.agentUserId) byChat.get(chatId)!.add(session.agentUserId);
          }
          const rows = [...byChat].map(([chatId, ids]) => [chatId, [...ids].sort()] as const).sort(([a], [b]) => a.localeCompare(b));
          // 哪个 agent 是哪条会话(这台电脑与连着的每台机器上的):资料卡「发消息」据此打开它的会话。
          const sessions = agentSessions().flatMap(({ agentUserId, projectId, sessionId }) => agentUserId ? [[agentUserId, { projectId, sessionId }] as const] : []).sort(([a], [b]) => a.localeCompare(b));
          return { chatIds, rows, sessions };
        },
        ({ chatIds, rows, sessions }) => publishProjectGroupChats(chatIds, new Map(rows), new Map(sessions)),
        { fireImmediately: true, equals: comparer.structural }
      );
      this.stop = () => {
        offHosts();
        offLocal();
        offMachines();
        offPublish();
      };
    }
  }

  refreshAll(): void {
    void this.refresh(null);
    for (const deviceId of this.syncedMachines()) void this.refresh(deviceId);
  }

  /** 这台机器上的绑定整份换成这一份(那台机器此刻的回答,或没连着时账号上记着的那份)。 */
  applyBindings(machine: string | null, bindings: readonly ProjectGroupBinding[]): void {
    runInAction(() => {
      for (const projectId of [...this.byProject.keys()]) {
        if ((machineRegistry.machineOf(projectId) ?? null) === machine) this.byProject.delete(projectId);
      }
      for (const binding of bindings) {
        if (machine) machineRegistry.register(machine, [binding.projectId]);
        this.byProject.set(binding.projectId, binding.chatId);
      }
    });
  }

  async refresh(machine: string | null): Promise<void> {
    try {
      const result = await rpcOn(machine).projects.listProjectGroupBindings();
      if (!result.success) {
        log.warn('[project-groups] 读不到这台机器上的项目群绑定', { machine, error: result.error });
        return;
      }
      this.applyBindings(machine, result.data);
    } catch (error) {
      log.warn('[project-groups] 读项目群绑定失败', { machine, error: String(error) });
    }
  }
}

export const projectGroupsStore = new ProjectGroupsStore();
