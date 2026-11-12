import { messageForUser } from '@/lib/userFacingError';
import { useEffect, type ReactNode } from 'react';
import { localMachineChoice } from '@renderer/features/remote-hosts/machine-choice';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { remoteChoice } from '@renderer/features/remote-hosts/use-new-session-machine';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { useMachineCreateContext } from '@renderer/features/sessions/use-machine-create-target';
import { electronApi } from '@renderer/lib/electron-api';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useEnsureMounted } from '@renderer/features/projects/hooks/use-ensure-mounted';
import { foldersInScope, machineOfKey, scopeKey, useProjectRunMachine } from './project-run-machine';
import { ProjectFolderCard, shortHome, type AttachMachine, type FolderCardMachine } from './project-folder-card';
import { linkFolderOnMachine, planAttach } from '@shared/core/projects/project-attach-flow';
import { projectLinkDeps } from '@renderer/features/projects/project-link-deps';
import { MAX_PROJECT_FOLDERS, useProjectFolders, type AttachResult } from './project-folders';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';

/**
 * 一个项目的文件夹卡和它背后的那一套(#7341):各台机器上的文件夹、设备范围、挂文件夹 / 接进来 / 并进来、
 * 新任务从哪个文件夹开工。项目首页摆着它;项目块里点「新任务」时它浮到群聊上面(gugu-dev#181)—— 两处是同一张卡、
 * 同一个选择,❌ 各写一份。
 */
export function useProjectFolderStage(projectId: string, { floating = false, onChosen }: {
  /** 浮在群聊上面(项目块里开新任务):卡一浮出来就摊开。 */
  floating?: boolean;
  /** 在卡上点中了一张(浮着的卡据此让开)。 */
  onChosen?: () => void;
} = {}) {
  const { translate } = useSessionMessages();
  const displayName = projectDisplayName(getProjectStore(projectId)) ?? '';
  // #7341 第二步:这个项目在各台机器上的本地项目(绑在同一个项目群上)。点进来的若是被并进别的行的那一个,按那一行看。
  const rowId = sidebarStore.rowProjectIdOf(projectId);
  const memberIds = sidebarStore.projectMembersOf(rowId);
  const folders = useProjectFolders(rowId, memberIds);
  const thisComputer: AttachMachine = { id: null, label: translate('task.deviceLocal'), online: true, kind: 'computer' };
  const describeMachine = (deviceId: string): AttachMachine => {
    const device = remoteHostsStore.device(deviceId);
    return {
      id: deviceId,
      label: device?.label ?? deviceId,
      online: remoteHostsStore.connectionState(deviceId) === 'connected',
      kind: device?.hostKind === 'desktop' ? 'computer' : 'server',
    };
  };
  const machineOf = (deviceId: string | null): FolderCardMachine => (deviceId ? describeMachine(deviceId) : thisComputer);
  // 「+」能挂到的机器:这台电脑 + 名下每台机器(此刻连不上的列着、灰掉)。
  const attachMachines: AttachMachine[] = [thisComputer, ...remoteHostsStore.pickableMachineIds().map(describeMachine)];
  // 有这个项目文件夹的机器 = 那台上的本地项目在这个项目里、而且挂着至少一个文件夹。从项目中摘除之后,那台的本地项目还在项目里
  // 但一个文件夹都没有:它归到分隔线下(点了重新挂),❌ 留在上面、选中了却说「文件夹暂不可用」。文件夹还没读到时照成员算。
  const hasFolderOn = (deviceId: string | null) =>
    folders.folders === null || folders.folders.some((folder) => scopeKey(folder.deviceId) === scopeKey(deviceId));
  const projectMachines = [...new Map(memberIds.flatMap((id) => {
    const deviceId = machineRegistry.machineOf(id) ?? null;
    return hasFolderOn(deviceId) ? [[deviceId, deviceId ? describeMachine(deviceId) : thisComputer] as const] : [];
  })).values()];
  // 在哪台跑:有这个项目文件夹的机器里选一台(默认规则见 defaultRunMachine);没有文件夹的机器在选择器分隔线下,点了先挂文件夹。
  const runMachine = useProjectRunMachine(
    rowId,
    projectMachines.map((machine) => ({ key: scopeKey(machine.id), online: machine.online })),
    accountProjectsStore.projectOfLocal(rowId)?.chatId,
  );
  const scopedFolders = foldersInScope(folders, runMachine.selected, (id) => machineRegistry.machineOf(id) ?? null, (deviceId) => {
    const state = remoteHostsStore.connectionState(deviceId);
    return state === 'asleep' || state === 'waking';
  });
  // 新会话开在哪:卡片 / 托盘上选中的那个文件夹所属的本地项目(可能在别的机器上);没选 = 这一页的项目。
  const targetProjectId = scopedFolders.chosen?.projectId ?? projectId;
  // 这一页画的项目和新会话要建进去的项目(选了别的机器上的文件夹时是那台上的本地项目)都要挂上:
  // 发送要它的会话列表,「在…中打开」要它的路径。
  useEnsureMounted([projectId, targetProjectId]);
  useEffect(() => remoteHostsStore.start(), []);
  // 在哪台上开工:选中的那个文件夹自己记着(folder.deviceId);没选 = 这一页的项目所在的那台。
  const executionDevice = scopedFolders.chosen ? scopedFolders.chosen.deviceId : machineRegistry.machineOf(targetProjectId) ?? null;
  const machineContext = useMachineCreateContext(executionDevice ? { deviceId: executionDevice, projectId: targetProjectId } : null);
  const machineLabel = (machine: string | null) => (machine ? describeMachine(machine).label : thisComputer.label);
  const showConfirm = useShowModal('confirmActionModal');

  const attachErrorText = (error: Extract<AttachResult, { ok: false }>['error']) => {
    switch (error.type) {
      case 'not-a-directory':
        return translate('projects.folders.errorNotDirectory');
      case 'is-project-root':
        return translate('projects.folders.errorIsProjectRoot', { projectName: error.projectName });
      case 'belongs-to-other-project':
        return translate('projects.folders.errorOtherProject', { projectName: error.projectName });
      default:
        log.error('[project-home] 挂文件夹失败', { projectId, error });
        return messageForUser(error);
    }
  };
  const sessionCountOf = (id: string) =>
    (sidebarStore.placement.entries.get(id) ?? []).filter((entry) => entry.projectId === id).length;
  const failLinking = (error: unknown) => {
    log.error('[project-home] 把别的机器上的文件夹接进这个项目失败', { projectId, error });
    toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
  };

  // 挂到这个项目在那台机器上已有的本地项目下(与第一步同一条路)。
  // 挂上了 = true(各条路同一个回答,托盘的机器选择器据此才选中那台)。
  const attachToMember = async (memberId: string, machine: string | null, path: string): Promise<boolean> => {
    const result = await folders.attach(memberId, path);
    if (!result.ok) {
      // 那个文件夹本身就是那台机器上的另一个项目 ⇒ 不是「挂不上」,是「要不要把那个项目并进来」。
      if (result.error.type === 'is-project-root' && !memberIds.includes(result.error.projectId)) {
        return confirmMerge(machine, result.error.projectId, result.error.projectName, path);
      }
      toast({ tier: 'error', title: attachErrorText(result.error) });
      return false;
    }
    const attached = result.folder;
    toast({
      // 挂在别的机器上:说是哪台(与「在那台机器上接进来」同一句),❌ 只给一条路径让人猜在哪台上。
      title: machine
        ? translate('projects.folders.attachedOn', { machine: machineLabel(machine), path: shortHome(attached.path), projectName: displayName })
        : translate('projects.folders.attached', { path: shortHome(attached.path), projectName: displayName }),
      // 挂错了能当场撤(product spec「挂文件夹」)。
      action: {
        label: translate('projects.folders.undo'),
        onClick: () => {
          void folders.detach(attached).then((ok) => {
            if (ok) toast({ title: translate('projects.folders.detached', { path: shortHome(attached.path), projectName: displayName }) });
          }).catch(failLinking);
        },
      },
      duration: 8000,
    });
    return true;
  };

  // 那台机器上还没有这个项目:在那台把文件夹认成项目(并进来的就用那一个),绑到这个项目的群上(product spec,owner 选 A)。
  const linkDeps = projectLinkDeps(displayName, sessionCountOf);
  const linkOnMachine = async (machine: string | null, path: string): Promise<boolean> => {
    try {
      const linked = await linkFolderOnMachine(linkDeps, { rowId, machine, path });
      projectGroupsStore.refreshAll();
      // 那台机器的项目清单变了(多了一个 / 绑了群):重读一遍,下次它离线时侧栏照样列着(❌ 只在连上那一刻读过)。
      const resyncMachine = () => (machine ? void remoteHostsStore.syncProjects(machine) : undefined);
      resyncMachine();
      if (!linked.ok) {
        failLinking(linked.error);
        return false;
      }
      toast({
        title: translate('projects.folders.attachedOn', { machine: machineLabel(machine), path: shortHome(path), projectName: displayName }),
        action: {
          label: translate('projects.folders.undo'),
          onClick: () => {
            void linked
              .undo()
              .then((ok) => {
                projectGroupsStore.refreshAll();
                resyncMachine();
                if (ok) toast({ title: translate('projects.folders.detached', { path: shortHome(path), projectName: displayName }) });
              })
              .catch(failLinking);
          },
        },
        duration: 8000,
      });
      return true;
    } catch (error) {
      failLinking(error);
      return false;
    }
  };

  // 那台机器上的这个文件夹已经是一个有会话的项目:先说清会发生什么,确认了才并(owner 2026-10-17 选 A)。
  const confirmMerge = (machine: string | null, existingProjectId: string, name: string, path: string): Promise<boolean> => {
    const count = sessionCountOf(existingProjectId);
    if (count === 0) return linkOnMachine(machine, path);
    return new Promise<boolean>((resolve) => showConfirm({
      title: translate('projects.folders.mergeTitle', { name, projectName: displayName }),
      description: translate('projects.folders.mergeDescription', { machine: machineLabel(machine), name, count, projectName: displayName }),
      confirmLabel: translate('projects.folders.mergeConfirm'),
      // 并进来不删任何东西(原来的群留作历史):❌ 删除那种红按钮。
      variant: 'default',
      onSuccess: () => resolve(linkOnMachine(machine, path)),
      // 取消 / Esc:没并,❌ 当成挂上了。
      onClose: () => resolve(false),
    }));
  };

  // 挂满了就当场说,❌ 先弹目录框、挑完才拒(各台机器上的合计;列表还没读到时数不出来,不拦)。
  const refuseWhenFull = () => {
    if ((folders.folders?.length ?? 0) < MAX_PROJECT_FOLDERS) return false;
    toast({ tier: 'error', title: translate('projects.folders.errorFull', { projectName: displayName, max: MAX_PROJECT_FOLDERS }) });
    return true;
  };

  const attachOn = async (machine: string | null, path: string): Promise<boolean> => {
    if (refuseWhenFull()) return false;
    const plan = await planAttach({
      machine,
      path,
      memberIds,
      machineOf: (id) => machineRegistry.machineOf(id) ?? null,
      inspect: (on, folder) => rpcOn(on).projects.inspectProjectPath({ type: 'local', path: folder }),
    }).catch((error: unknown) => {
      // 那台机器答不上「这个文件夹在它那里是什么」:如实说没挂上,❌ 当成「什么都不是」去建一个。
      failLinking(error);
      return null;
    });
    if (!plan) return false;
    switch (plan.kind) {
      case 'member':
        return attachToMember(plan.memberId, machine, path);
      case 'merge':
        return confirmMerge(machine, plan.projectId, plan.name, path);
      case 'taken':
        toast({ tier: 'error', title: translate('projects.folders.errorOtherProject', { projectName: plan.projectName }) });
        return false;
      case 'link':
        return linkOnMachine(machine, path);
    }
  };

  // 「+」:在选的那台机器上挑文件夹 —— 本机弹系统的目录框,别的机器由那台机器画目录树(同「新建项目 › 使用现有文件夹」)。
  const pickAndAttach = (machine: string | null): Promise<boolean> => {
    if (refuseWhenFull()) return Promise.resolve(false);
    const picked = machine
      ? (remoteHostsStore.connectionState(machine) === 'asleep'
          ? remoteHostsStore.wakeCloudComputer(machine)
          : Promise.resolve(true)
        ).then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: displayName }),
          message: translate('projects.folders.attachDialogMessage'),
        });
    return picked
      // 挑了路径不等于挂上了(那是别的项目的文件夹、并入被取消、接进来失败):只有挂上了才算。
      .then((path) => (path ? attachOn(machine, path) : false))
      .catch((error: unknown) => {
        log.error('[project-home] 挂文件夹失败', { projectId, error });
        return false;
      });
  };
  // 从 Finder 拖进来的是这台电脑上的文件夹:挂到这个项目在这台电脑上的那一个(没有就在这台电脑上接进来)。
  const dropFolder = (file: File) => {
    const path = electronApi().getPathForFile(file).trim();
    if (!path) {
      toast({ tier: 'error', title: translate('projects.folders.errorNotDirectory') });
      return;
    }
    void attachOn(null, path);
  };

  // 托盘上的机器选择器:上面是有这个项目文件夹的机器(淡色字 = 那台上的文件夹),分隔线下是还没有的,点了先在那台上挑文件夹、挂上就选中它。
  const choiceOf = (deviceId: string | null) => (deviceId ? remoteChoice(deviceId, translate) : localMachineChoice('local', thisComputer.label));
  const folderOn = (key: string) => folders.folders?.find((folder) => scopeKey(folder.deviceId) === key && folder.kind === 'root')
    ?? folders.folders?.find((folder) => scopeKey(folder.deviceId) === key);
  const withFolder = new Set(projectMachines.map((machine) => scopeKey(machine.id)));
  const runMachinePicker = (
    <MachinePicker
      size="compact"
      testId="composer-device-picker"
      wakeOnPick="retry"
      machines={projectMachines.map((machine) => choiceOf(machine.id))}
      selectedId={runMachine.selected[0] ?? null}
      onSelect={(key) => runMachine.pick(machineOfKey(key))}
      metaOf={(machine) => { const folder = folderOn(machine.id); return folder ? shortHome(folder.path) : null; }}
      elsewhere={{
        machines: attachMachines.filter((machine) => !withFolder.has(scopeKey(machine.id))).map((machine) => choiceOf(machine.id)),
        onPick: (key) => {
          const machine = machineOfKey(key);
          void pickAndAttach(machine).then((picked) => { if (picked) runMachine.pick(machine); });
        },
      }}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
    />
  );

  const card: ReactNode = (
    <ProjectFolderCard
      projectId={rowId}
      projectName={displayName}
      folders={{ ...folders, chosen: scopedFolders.chosen, choose: (workspaceId) => {
        const folder = folders.folders?.find((item) => item.workspaceId === workspaceId);
        if (folder) runMachine.pick(folder.deviceId);
        folders.choose(workspaceId);
        onChosen?.();
      } }}
      memberIds={memberIds}
      machines={projectMachines.map((machine) => machine.id)}
      machineOf={machineOf}
      attachMachines={attachMachines}
      onAttach={pickAndAttach}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
      onDropFolder={dropFolder}
      floating={floating}
    />
  );
  return {
    rowId, displayName, folders, runMachine, runMachinePicker, scopedFolders, targetProjectId, machineContext, projectMachines,
    machineOf, pickAndAttach, card,
  };
}

export type ProjectFolderStage = ReturnType<typeof useProjectFolderStage>;
