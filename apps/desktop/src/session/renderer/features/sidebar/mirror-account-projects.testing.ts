import { runInAction } from 'mobx';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { AccountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { isWorkspaceProject } from '@renderer/features/sessions/session-home-project-constants';
import { SidebarStore } from './sidebar-store';

// Test support only: sidebar layout tests that are not about where projects come from.

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

export const THIS_COMPUTER = 'this-computer';

/**
 * 账号上的项目照项目表镜像出来:每个不是 workspace 的本地项目各是一个项目,`groupOf` 给了同一个群的并成一个项目
 * (名字取第一个)。绑定的机器 = 侧栏注入的 machineOf(这台电脑 = THIS_COMPUTER)。
 */
class MirrorAccounts extends AccountProjectsStore {
  constructor(
    private readonly manager: SidebarProjectManager,
    private readonly groupOf: (projectId: string) => string | undefined,
  ) {
    super();
    runInAction(() => {
      this.status = 'ready';
      this.localDeviceId = THIS_COMPUTER;
    });
  }

  override get projects(): readonly AccountProject[] {
    const byChat = new Map<string, AccountProject>();
    for (const project of this.manager.projects.values()) {
      const chatId = this.groupOf(project.id) ?? (isWorkspaceProject(project) ? undefined : `chat:${project.id}`);
      if (!chatId) continue;
      const account = byChat.get(chatId) ?? { chatId, name: project.name ?? '', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] };
      account.bindings.push({ deviceId: this.local?.machineOf(project.id) ?? THIS_COMPUTER, localProjectId: project.id });
      byChat.set(chatId, account);
    }
    return [...byChat.values()];
  }
}

/** A sidebar whose account projects mirror its project table (see MirrorAccounts). */
export function sidebarOf(manager: SidebarProjectManager, groupOf: (projectId: string) => string | undefined = () => undefined): SidebarStore {
  const accounts = new MirrorAccounts(manager, groupOf);
  const store = new SidebarStore(manager, accounts);
  accounts.attach({
    projects: manager.projects,
    machineOf: (id) => store.machines?.machineOf(id) ?? null,
    connected: (deviceId) => store.machines?.connected?.(deviceId) === true,
  });
  return store;
}
