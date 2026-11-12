import { observer } from 'mobx-react-lite';
import { messageForUser } from '@/lib/userFacingError';
import { Folder } from '@/lib/icons';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { localMachineChoice, machineAcceptsWork, orderMachines } from '@renderer/features/remote-hosts/machine-choice';
import { MachineRow } from '@renderer/features/remote-hosts/machine-picker';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { remoteChoice } from '@renderer/features/remote-hosts/use-new-session-machine';
import { projectLinkDeps } from '@renderer/features/projects/project-link-deps';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { linkFolderOnMachine } from '@shared/core/projects/project-attach-flow';
import { log } from '@renderer/utils/logger';

const LOCAL = 'local';

/**
 * 项目选择器里一个哪台机器上都还没有文件夹的项目(项目与机器解耦:项目在账号上,一个文件夹都没有也是项目)。
 * › 里是机器:选一台 → 在那台上挑文件夹 → 认成这个项目、绑到它的群上(与项目块「+」同一条 linkFolderOnMachine)→ 打开它。
 */
export const FolderlessProjectItem = observer(function FolderlessProjectItem({
  project,
  onProjectReady,
}: {
  project: AccountProject;
  onProjectReady: (projectId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const machines = orderMachines([
    localMachineChoice(LOCAL, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map((id) => remoteChoice(id, translate)),
  ]);
  const bindOn = async (key: string) => {
    const machine = key === LOCAL ? null : key;
    const path = machine
      ? await (remoteHostsStore.connectionState(machine) === 'asleep' ? remoteHostsStore.wakeCloudComputer(machine) : Promise.resolve(true))
          .then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : await rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: project.name }),
          message: translate('projects.folders.attachDialogMessage'),
        });
    if (!path) return;
    const linked = await linkFolderOnMachine(
      projectLinkDeps(project.name, () => 0, async () => ({ success: true, data: { chatId: project.chatId } })),
      { rowId: project.chatId, machine, path },
    );
    projectGroupsStore.refreshAll();
    if (machine) void remoteHostsStore.syncProjects(machine);
    if (!linked.ok) throw linked.error;
    onProjectReady(linked.projectId);
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="folderless-project" data-chat-id={project.chatId}>
        <Folder className="size-3.5" />
        <span className="truncate">{project.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        {machines.map((machine) => (
          <DropdownMenuItem
            key={machine.id}
            data-device-id={machine.id}
            disabled={!machineAcceptsWork(machine)}
            onClick={() => {
              void bindOn(machine.id).catch((error: unknown) => {
                log.error('[projects] 在那台机器上给项目挂第一个文件夹失败', { chatId: project.chatId, error });
                toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
              });
            }}
          >
            <MachineRow machine={machine} meta={null} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});
