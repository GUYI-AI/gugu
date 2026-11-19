import { observer } from 'mobx-react-lite';
import { messageForUser } from '@/lib/userFacingError';
import { Folder } from '@/lib/icons';
import { localMachineChoice, machineAcceptsWork, orderMachines } from '@renderer/features/remote-hosts/machine-choice';
import { MachineRow } from '@renderer/features/remote-hosts/machine-picker';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { remoteChoice } from '@renderer/features/remote-hosts/use-new-session-machine';
import { carryRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine';
import { shortHome } from '@renderer/features/projects/components/main-panel/project-folder-card';
import { rememberFolderChoice } from '@renderer/features/folders/group-folders';
import { groupFoldersStore, type GroupFolder, type GroupWithFolders } from '@renderer/features/folders/group-folders-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';

const LOCAL = 'local';

/**
 * A group in the group picker (the first picker above the composer): a group with a folder on one of my machines. Each row
 * has ›: its folders, one row「device · path」; picking one picks the group, the device and the folder at once. This is
 * also where the person finds every folder of theirs by group.
 * With no folder usable now (all on machines that are offline), › offers「pick a folder on some device」instead: pick a
 * machine → pick a folder there → bind it to this group → open it. Binding more folders is the group page's「+」.
 */
export const ProjectPickerItem = observer(function ProjectPickerItem({
  group,
  twin,
  onSelect,
}: {
  group: GroupWithFolders;
  twin: boolean;
  onSelect: (chatId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const name = group.name || translate('task.projectFallbackName');
  // Two groups of one name must be told apart: the first folder's path (this computer's first) tells them.
  const first = group.folders[0];
  const hint = twin && first ? shortHome(first.path) || undefined : undefined;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="project-picker-item" data-chat-id={group.chatId}>
        <Folder className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {hint ? <small className="min-w-0 max-w-[55%] shrink truncate pl-3 text-foreground-passive">{hint}</small> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <ChoiceList group={group} onSelect={onSelect} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

const ChoiceList = observer(function ChoiceList({ group, onSelect }: { group: GroupWithFolders; onSelect: (chatId: string) => void }) {
  const { translate } = useSessionMessages();
  const choiceOf = (deviceId: string | null) => (deviceId ? remoteChoice(deviceId, translate) : localMachineChoice(LOCAL, translate('task.deviceLocal')));
  const folders = group.folders;
  const usable = folders.some((folder) => !folder.offline);

  const choose = (folder: GroupFolder) => {
    rememberFolderChoice(group.chatId, folder.id);
    // The machine of the folder picked is handed to the group page; it is remembered on the account once a task is created there.
    carryRunMachine(group.chatId, folder.deviceId);
    onSelect(group.chatId);
  };

  const bindOn = async (key: string) => {
    const machine = key === LOCAL ? null : key;
    const path = machine
      ? await (remoteHostsStore.connectionState(machine) === 'asleep' ? remoteHostsStore.wakeCloudComputer(machine) : Promise.resolve(true))
          .then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : await rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: group.name }),
          message: translate('projects.folders.attachDialogMessage', { projectName: group.name }),
        });
    if (!path) return;
    const bound = await rpcOn(machine).folders.bindFolderAtPath({ path, chatId: group.chatId });
    if (!bound.success) throw new Error(bound.error.type, { cause: bound.error });
    void groupFoldersStore.readMachine(machine);
    rememberFolderChoice(group.chatId, bound.data.id);
    carryRunMachine(group.chatId, machine);
    onSelect(group.chatId);
  };

  const machines = orderMachines([
    localMachineChoice(LOCAL, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map((id) => remoteChoice(id, translate)),
  ]);

  return (
    <>
      {folders.map((folder) => (
        <DropdownMenuItem
          key={`${folder.deviceId ?? LOCAL}:${folder.id}`}
          data-device-id={folder.deviceId ?? LOCAL}
          data-workspace-id={folder.id}
          disabled={folder.offline}
          onClick={() => choose(folder)}
        >
          <MachineRow machine={choiceOf(folder.deviceId)} meta={shortHome(folder.path)} />
        </DropdownMenuItem>
      ))}
      {!usable ? (
        <>
          {folders.length > 0 ? <DropdownMenuSeparator /> : null}
          {machines.map((machine) => (
            <DropdownMenuItem
              key={machine.id}
              data-device-id={machine.id}
              data-testid="project-pick-folder-on"
              disabled={!machineAcceptsWork(machine)}
              onClick={() => {
                void bindOn(machine.id).catch((error: unknown) => {
                  log.error('[group-folders] binding a folder on that machine failed', { chatId: group.chatId, error });
                  toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
                });
              }}
            >
              <Folder className="size-3.5" />
              <span className="truncate">{translate('projects.picker.pickFolderOn', { machine: machine.label })}</span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
    </>
  );
});
