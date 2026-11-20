import { messageForUser } from '@/lib/userFacingError';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { useEffect, type ReactNode } from 'react';
import type { FolderError, FolderRecord } from '@shared/core/folders/folders';
import { localMachineChoice } from '@renderer/features/remote-hosts/machine-choice';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { remoteChoice } from '@renderer/features/remote-hosts/use-new-session-machine';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useMachineCreateContext } from '@renderer/features/sessions/use-machine-create-target';
import { useEnsureMounted } from '@renderer/features/projects/hooks/use-ensure-mounted';
import { foldersInScope, machineOfKey, scopeKey, useProjectRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine';
import { ProjectFolderCard, shortHome, type AttachMachine, type FolderCardMachine } from '@renderer/features/projects/components/main-panel/project-folder-card';
import { electronApi } from '@renderer/lib/electron-api';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { MAX_GROUP_FOLDERS, useGroupFolders } from './group-folders';
import { groupFoldersStore } from './group-folders-store';

/**
 * A group's folder card and what stands behind it: its folders on each of my machines, which machine a new task runs on,
 * binding a folder (or moving one here from another group), and which folder a new task starts in. The empty group page
 * shows it; choosing「新任务」 in the group floats it above the conversation (gugu-dev#181) — one card, one choice, ❌ two.
 */
export function useGroupFolderStage(chatId: string, { floating = false, onChosen }: {
  /** Floats above the conversation (a new task in the group): it opens as soon as it floats. */
  floating?: boolean;
  /** A paper was picked on the card (the floating card gets out of the way). */
  onChosen?: () => void;
} = {}) {
  const { translate } = useSessionMessages();
  const groupName = readChatSummary(chatId)?.name ?? '';
  const folders = useGroupFolders(chatId);
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
  // Where「+」can bind: this computer and every machine of mine (unreachable ones listed, greyed).
  const attachMachines: AttachMachine[] = [thisComputer, ...remoteHostsStore.pickableMachineIds().map(describeMachine)];
  // The machines that hold a folder of this group (in the order the folders are listed: this computer first). A group with
  // no folder anywhere runs its tasks on this computer, in the task home (v2 ⑨, Q5).
  const folderless = folders.folders?.length === 0;
  const groupMachines = folderless ? [thisComputer]
    : [...new Map((folders.folders ?? []).map((folder) => [scopeKey(folder.deviceId), machineOf(folder.deviceId)] as const)).values()];
  const runMachine = useProjectRunMachine(
    chatId,
    groupMachines.map((machine) => ({ key: scopeKey(machine.id ?? null), online: machine.online })),
    chatId,
  );
  const scopedFolders = foldersInScope(folders, runMachine.selected, (deviceId) => {
    const state = remoteHostsStore.connectionState(deviceId);
    return state === 'asleep' || state === 'waking';
  });
  // The machine a new task starts on = the one the tray shows (runMachine); its folder is chosen among that machine's.
  // No folder anywhere = this computer (a group without folders runs its tasks in the task home, Q5).
  const executionDevice = runMachine.machine !== undefined ? runMachine.machine : null;
  const targetFolderId = scopedFolders.chosen?.id ?? null;
  // The folder a new session is created in must be mounted: sending needs its session list.
  useEnsureMounted(targetFolderId ? [targetFolderId] : []);
  useEffect(() => remoteHostsStore.start(), []);
  const machineContext = useMachineCreateContext(executionDevice ? { deviceId: executionDevice, projectId: targetFolderId ?? undefined } : null);
  const machineLabel = (machine: string | null) => (machine ? describeMachine(machine).label : thisComputer.label);
  const showConfirm = useShowModal('confirmActionModal');

  const bindErrorText = (error: FolderError | { type: 'rpc-failed'; message: string }) => {
    if (error.type === 'not-a-directory') return translate('projects.folders.errorNotDirectory');
    log.error('[group-folders] binding a folder failed', { chatId, error });
    return error.type === 'rpc-failed' || error.type === 'inspect-failed' ? error.message : translate('projects.folders.errorAttach');
  };
  const failBinding = (error: unknown) => {
    log.error('[group-folders] binding a folder failed', { chatId, error });
    toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
  };

  /** Bind the directory at `path` on `machine` to this group; `move` = it is bound to another group and the person agreed. */
  const bindOn = async (machine: string | null, path: string, move = false): Promise<boolean> => {
    let result: Awaited<ReturnType<typeof rpc.folders.bindFolderAtPath>>;
    try {
      result = await rpcOn(machine).folders.bindFolderAtPath({ path, chatId, move });
    } catch (error) {
      failBinding(error);
      return false;
    }
    if (!result.success) {
      if (result.error.type === 'bound-elsewhere') return confirmMove(machine, path, result.error.chatId);
      toast({ tier: 'error', title: bindErrorText(result.error) });
      return false;
    }
    const folder: FolderRecord = result.data;
    folders.bound(folder);
    void groupFoldersStore.readMachine(machine);
    toast({
      title: machine
        ? translate('projects.folders.attachedOn', { machine: machineLabel(machine), path: shortHome(folder.path), projectName: groupName })
        : translate('projects.folders.attached', { path: shortHome(folder.path), projectName: groupName }),
      // Bound by mistake: undo it right there.
      action: {
        label: translate('projects.folders.undo'),
        onClick: () => {
          void rpcOn(machine).folders.unbindFolder(folder.id).then((undone) => {
            if (!undone.success) throw new Error(undone.error.type, { cause: undone.error });
            void groupFoldersStore.readMachine(machine);
            toast({ title: translate('projects.folders.detached', { path: shortHome(folder.path), projectName: groupName }) });
          }).catch(failBinding);
        },
      },
      duration: 8000,
    });
    return true;
  };

  // The folder is bound to another group on that machine: say so, and move it here only when the person agrees. The other
  // group and its history stay as they are (its sessions keep the group they were started in).
  const confirmMove = (machine: string | null, path: string, otherChatId: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => showConfirm({
      title: translate('projects.folders.errorOtherProject', { projectName: readChatSummary(otherChatId)?.name ?? '' }),
      description: translate('projects.folders.moveDescription', { projectName: groupName }),
      confirmLabel: translate('projects.folders.moveConfirm'),
      variant: 'default',
      onSuccess: () => resolve(bindOn(machine, path, true)),
      onClose: () => resolve(false),
    }));

  // Full: say it now, ❌ after the directory dialog (all machines together; not known yet = not refused).
  const refuseWhenFull = () => {
    if ((folders.folders?.length ?? 0) < MAX_GROUP_FOLDERS) return false;
    toast({ tier: 'error', title: translate('projects.folders.errorFull', { projectName: groupName, max: MAX_GROUP_FOLDERS }) });
    return true;
  };

  //「+」: pick a folder on the chosen machine — this computer opens the system's directory dialog, another machine draws its
  // directory tree. Bound = true (the tray's machine picker then selects that machine).
  const pickAndAttach = (machine: string | null): Promise<boolean> => {
    if (refuseWhenFull()) return Promise.resolve(false);
    const picked = machine
      ? (remoteHostsStore.connectionState(machine) === 'asleep'
          ? remoteHostsStore.wakeCloudComputer(machine)
          : Promise.resolve(true)
        ).then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: groupName }),
          message: translate('projects.folders.attachDialogMessage', { projectName: groupName }),
        });
    return picked
      .then((path) => (path ? bindOn(machine, path) : false))
      .catch((error: unknown) => {
        failBinding(error);
        return false;
      });
  };
  // A folder dragged in from Finder is on this computer: bind it to this group here.
  const dropFolder = (file: File) => {
    const path = electronApi().getPathForFile(file).trim();
    if (!path) {
      toast({ tier: 'error', title: translate('projects.folders.errorNotDirectory') });
      return;
    }
    if (!refuseWhenFull()) void bindOn(null, path);
  };

  // The tray's machine picker: above, the machines with a folder of this group (the folder's path beside); below the
  // divider, the others — picking one first picks a folder there, and once bound selects that machine.
  const choiceOf = (deviceId: string | null) => (deviceId ? remoteChoice(deviceId, translate) : localMachineChoice('local', thisComputer.label));
  const folderOn = (key: string) => folders.folders?.find((folder) => scopeKey(folder.deviceId) === key);
  const withFolder = new Set(groupMachines.map((machine) => scopeKey(machine.id ?? null)));
  const runMachinePicker = (
    <MachinePicker
      size="compact"
      testId="composer-device-picker"
      wakeOnPick="retry"
      machines={groupMachines.map((machine) => choiceOf(machine.id ?? null))}
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
      chatId={chatId}
      groupName={groupName}
      folders={{ ...folders, chosen: scopedFolders.chosen, choose: (folderId) => {
        const folder = folders.folders?.find((item) => item.id === folderId);
        if (folder) runMachine.pick(folder.deviceId);
        folders.choose(folderId);
        onChosen?.();
      } }}
      machines={groupMachines.map((machine) => machine.id ?? null)}
      machineOf={machineOf}
      attachMachines={attachMachines}
      onAttach={pickAndAttach}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
      onDropFolder={dropFolder}
      floating={floating}
    />
  );
  return {
    chatId, groupName, folders, folderless, runMachine, runMachinePicker, scopedFolders, targetFolderId, executionDevice, machineContext,
    machineOf, pickAndAttach, card,
  };
}

export type GroupFolderStage = ReturnType<typeof useGroupFolderStage>;
