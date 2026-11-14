import { rpc, rpcOn } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import type { LinkFolderDeps } from '@shared/core/projects/project-attach-flow';

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * 在一台机器上把文件夹接进一个项目所需的那几步(项目首页的「+」、项目块机器选择器分隔线下那几台、项目选择器里还没有文件夹的项目
 * 共用这一份)。`ensureGroup` 缺省 = 问这一行所在的机器要这个项目的群;项目只在账号上(一个文件夹都没有)时由调用方给出它的群。
 */
export function projectLinkDeps(
  displayName: string,
  sessionCountOf: (projectId: string) => number,
  ensureGroup: LinkFolderDeps['ensureGroup'] = (row) => rpc.projects.ensureProjectGroup(row),
): LinkFolderDeps {
  return {
    ensureGroup,
    createProjectOn: async (machine, path) => {
      // 那台机器上的这个项目就是这个项目(product spec「项目不属于任何一台机器」):叫同一个名字,
      // ❌ 用文件夹名 —— 否则那台机器的侧栏、这边的托盘上同一个项目各叫各的(实机:「shop」挂进去成了「shop-on-b」)。
      const started = await appState.projects.startProjectCreation(
        machine ? { type: 'local', machine } : { type: 'local' },
        { mode: 'pick', path, name: displayName || folderName(path), initGitRepository: false, createDirectory: false, allowNonGit: true }
      );
      if (started.kind === 'existing') return { projectId: started.projectId, created: false };
      const completion = await started.completion;
      if (!completion.success) return null;
      if (machine) await appState.projects.ensureMounted(started.projectId);
      return { projectId: started.projectId, created: true };
    },
    bind: (machine, linked, chatId) => rpcOn(machine).projects.bindProjectToGroup(linked, chatId),
    unbind: (machine, linked) => rpcOn(machine).projects.unbindProjectGroup(linked),
    deleteProject: (linked) => appState.projects.deleteProject(linked),
    sessionCountOf,
  };
}
