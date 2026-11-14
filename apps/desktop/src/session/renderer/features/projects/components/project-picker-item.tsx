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
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { carryRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine';
import { shortHome } from '@renderer/features/projects/components/main-panel/project-folder-card';
import { rememberFolderChoice, type ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders';
import { useProjectPickerFolders } from '@renderer/features/projects/components/project-picker-folders';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { linkFolderOnMachine } from '@shared/core/projects/project-attach-flow';
import { log } from '@renderer/utils/logger';

const LOCAL = 'local';

/**
 * 项目选择器里的一个项目(项目与机器解耦:项目在账号上)。每个项目都有 ›:里面是它已有的文件夹,一行「设备 · 路径」,
 * 点中就同时选了项目、设备和文件夹(选文件夹 = 选设备)。
 * 没有一个能用的文件夹(账号上一个都没有 / 都在此刻连不上的设备上)时,› 里改给「在某台设备上选文件夹」:
 * 选一台 → 在那台上挑文件夹 → 认成这个项目、绑到它的群上(与项目块「+」同一条 linkFolderOnMachine)→ 打开它。
 * 挂更多文件夹是项目块上的事,这里只管从已有的里选。
 */
export const ProjectPickerItem = observer(function ProjectPickerItem({
  project,
  twin,
  onSelect,
}: {
  project: AccountProject;
  twin: boolean;
  onSelect: (projectId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const representative = accountProjectsStore.representativeOf(project.chatId);
  const rowId = representative ? sidebarStore.rowProjectIdOf(representative) : undefined;
  const name = project.name || (representative ? projectDisplayName(getProjectStore(representative)) : '') || translate('task.projectFallbackName');
  // 同名的两个项目要分得出:有文件夹的带代表那一个的路径、只在别的设备上的带设备名;一个都没有的如实说,不论同不同名。
  const hint = (() => {
    if (project.bindings.length === 0) return translate('projects.picker.noFolder');
    if (!twin) return undefined;
    if (representative) return shortHome(getProjectStore(representative)?.data?.path ?? '') || undefined;
    return deviceLabel(project.bindings[0]!.deviceId, translate);
  })();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="project-picker-item" data-chat-id={project.chatId}>
        <Folder className="size-3.5" />
        {/* 名字占满剩下的宽度,淡色提示紧贴 › 左边(›自己带 ml-auto,两个 ml-auto 会把提示挤到行中间)。 */}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {hint ? <small className="min-w-0 max-w-[55%] shrink truncate pl-3 text-foreground-passive">{hint}</small> : null}
      </DropdownMenuSubTrigger>
      {/* 只在展开时才挂上:读文件夹要问各台机器,❌ 每一行都先读。 */}
      <DropdownMenuSubContent className="min-w-56">
        <ProjectChoices project={project} representative={representative} rowId={rowId} onSelect={onSelect} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

function deviceLabel(deviceId: string, translate: ReturnType<typeof useSessionMessages>['translate']): string {
  if (deviceId === accountProjectsStore.localDeviceId) return translate('task.deviceLocal');
  return remoteHostsStore.device(deviceId)?.label ?? deviceId;
}

const ProjectChoices = observer(function ProjectChoices({ project, representative, rowId, onSelect }: {
  project: AccountProject;
  representative: string | undefined;
  rowId: string | undefined;
  onSelect: (projectId: string) => void;
}) {
  // 这一端项目表里认得的本地项目有文件夹就列;认不得的绑定(那台设备此刻没连上、没同步过来)列成灰的,❌ 当成没有。
  if (representative && rowId) return <MemberChoices project={project} representative={representative} rowId={rowId} onSelect={onSelect} />;
  return <ChoiceList project={project} folders={[]} readFailed={false} reading={false} rowId={undefined} representative={undefined} onSelect={onSelect} />;
});

const MemberChoices = observer(function MemberChoices({ project, representative, rowId, onSelect }: {
  project: AccountProject;
  representative: string;
  rowId: string;
  onSelect: (projectId: string) => void;
}) {
  const { folders, readFailed, reading } = useProjectPickerFolders(rowId);
  return <ChoiceList project={project} folders={folders} readFailed={readFailed} reading={reading} rowId={rowId} representative={representative} onSelect={onSelect} />;
});

const ChoiceList = observer(function ChoiceList({ project, folders, readFailed, reading, rowId, representative, onSelect }: {
  project: AccountProject;
  folders: readonly ShownFolder[];
  readFailed: boolean;
  reading: boolean;
  rowId: string | undefined;
  representative: string | undefined;
  onSelect: (projectId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const choiceOf = (deviceId: string | null) => (deviceId ? remoteChoice(deviceId, translate) : localMachineChoice(LOCAL, translate('task.deviceLocal')));
  const folderDevices = new Set(folders.map((folder) => folder.deviceId ?? accountProjectsStore.localDeviceId));
  // 绑在账号上、这一端没有对应本地项目的设备:列出来、灰着,说它此刻用不了。
  const unreachable = project.bindings
    .map((binding) => binding.deviceId)
    .filter((deviceId, index, all) => all.indexOf(deviceId) === index && !folderDevices.has(deviceId));
  const usable = folders.some((folder) => !folder.offline);

  const choose = (folder: ShownFolder) => {
    if (!rowId || !representative) return;
    rememberFolderChoice(rowId, folder.workspaceId);
    // 选了哪台的文件夹 = 选了那台:交给接下来打开的项目块,在它上面真建了任务才记上账号(同新建任务页上先选机器再选项目)。
    carryRunMachine(rowId, folder.deviceId);
    onSelect(representative);
  };

  const bindOn = async (key: string) => {
    const machine = key === LOCAL ? null : key;
    const path = machine
      ? await (remoteHostsStore.connectionState(machine) === 'asleep' ? remoteHostsStore.wakeCloudComputer(machine) : Promise.resolve(true))
          .then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : await rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: project.name }),
          message: translate('projects.folders.attachDialogMessage', { projectName: project.name }),
        });
    if (!path) return;
    const linked = await linkFolderOnMachine(
      // 这一端已有这个项目的本地项目 = 照项目块那一条路问它的群;一个都没有 = 项目只在账号上,群就是它自己。
      rowId
        ? projectLinkDeps(project.name, () => 0)
        : projectLinkDeps(project.name, () => 0, async () => ({ success: true, data: { chatId: project.chatId } })),
      { rowId: rowId ?? project.chatId, machine, path },
    );
    projectGroupsStore.refreshAll();
    if (machine) void remoteHostsStore.syncProjects(machine);
    if (!linked.ok) throw linked.error;
    onSelect(linked.projectId);
  };

  const machines = orderMachines([
    localMachineChoice(LOCAL, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map((id) => remoteChoice(id, translate)),
  ]);

  return (
    <>
      {reading ? <DropdownMenuLabel className="text-xs text-foreground-muted">{translate('projects.folders.loading')}</DropdownMenuLabel> : null}
      {readFailed ? <DropdownMenuLabel className="text-xs text-foreground-muted">{translate('projects.picker.readFailed')}</DropdownMenuLabel> : null}
      {folders.map((folder) => (
        <DropdownMenuItem
          key={folder.workspaceId}
          data-device-id={folder.deviceId ?? LOCAL}
          data-workspace-id={folder.workspaceId}
          disabled={folder.offline}
          onClick={() => choose(folder)}
        >
          <MachineRow machine={choiceOf(folder.deviceId)} meta={shortHome(folder.path)} />
        </DropdownMenuItem>
      ))}
      {unreachable.map((deviceId) => (
        <DropdownMenuItem key={deviceId} data-device-id={deviceId} disabled>
          <Folder className="size-3.5" />
          <span className="truncate">{translate('projects.picker.deviceUnavailable', { device: deviceLabel(deviceId, translate) })}</span>
        </DropdownMenuItem>
      ))}
      {!usable && !reading && !readFailed ? (
        <>
          {folders.length + unreachable.length > 0 ? <DropdownMenuSeparator /> : null}
          {machines.map((machine) => (
            <DropdownMenuItem
              key={machine.id}
              data-device-id={machine.id}
              data-testid="project-pick-folder-on"
              disabled={!machineAcceptsWork(machine)}
              onClick={() => {
                void bindOn(machine.id).catch((error: unknown) => {
                  log.error('[projects] 在那台机器上给项目挂文件夹失败', { chatId: project.chatId, error });
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
