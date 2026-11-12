// gugu #2525: 共享 Session Composer 的「创建上下文」托盘 —— 设备 · 项目两个按需披露的选择器。
// 设备那一格是全 app 共用的机器选择器(remote-hosts/machine-picker 的 compact 尺寸),这里只放项目选择器。
//
// 规范（#2505 product spec §共享创建器 / §设备与项目默认值）要求各创建入口复用同一套创建能力，
// 所以托盘控件抽在这里共用：新建页 new-session-page.tsx、项目页、对话里派任务都用它。
// 项目选择器列的是账号下的项目,与选了哪台机器无关(项目与机器解耦);在哪台跑由机器选择器定。
// ❌ 不各写一份：两份一旦分叉，「记住最近一次选择」就会在两个入口给出不同答案。
//
// 设备维度的数据与 per-user 记忆都在 gugu 侧（identity.gugu_devices + identity.user_settings）；
// 这里只负责渲染与回调。
import { nameTwinIds } from '@renderer/features/projects/name-twins';
import { ChevronDown, Folder, Plus, Users, X } from '@/lib/icons'
import { MenuSearch } from '@/components/ui/Menu'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ProjectCreationMenuItems } from '@renderer/features/projects/components/project-creation-menu-items';
import { RemoteProjectMenuItems } from '@renderer/features/sidebar/remote-project-menu-items';
import { FolderlessProjectItem } from '@renderer/features/projects/components/folderless-project-item';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { AccountProjectsError } from '@renderer/features/projects/components/account-projects-error';
import {
  getProjectStore,
  projectDisplayName
} from '@renderer/features/projects/stores/project-selectors';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu';
import { sessionComposerTrayTriggerClassName } from './session-composer-styles';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 账号下的项目(项目与机器解耦,accountProjectsStore,归档的不列)。❌ 按「这台电脑上挂没挂上」「在哪台机器上」过滤:
 * 在哪台跑是选了项目之后的事(项目块的机器选择器)。
 */
export function accountProjects(): AccountProject[] {
  return accountProjectsStore.projects.filter((project) => !project.archived);
}

/**
 * 这次建的 agent 进哪个群(在群里派任务 / 群成员里点的「新建 Agent」):建好就进群,结果回这个群。
 * gugu-dev#181:❌「不加入」—— 不进群,结果就回不来。只是一枚说明,不是选择。
 * 读成「进群：群名」(#2548 mock v33 派智能体)。
 */
export function ComposerBirthGroupChip({ name }: { name: string }) {
  const { translate } = useSessionMessages();
  return (
    <span className={sessionComposerTrayTriggerClassName} title={translate('newAgent.birthGroupHint')} data-testid="composer-birth-group">
      <Users className="size-3 shrink-0" />
      <span className="max-w-[200px] truncate">{translate('newAgent.birthGroup', { name })}</span>
    </span>
  );
}

export const ComposerProjectPicker = observer(function ComposerProjectPicker({
  selectedId,
  onSelect,
  unavailableHint,
  allowNone = true,
}: {
  selectedId: string | undefined;
  onSelect: (projectId: string | undefined) => void;
  /** 非空 = 所选设备的项目列表读不到，展示这句话而不是一份不属于它的列表。 */
  unavailableHint?: string | null;
  /** 项目页:这一页就是某个项目的,没有「不选项目」这一项。 */
  allowNone?: boolean;
}) {
  const { translate } = useSessionMessages();
  const projects = accountProjects();
  const [projectQuery, setProjectQuery] = useState('');
  // 搜索按项目名过滤。
  const query = projectQuery.trim().toLowerCase();
  const visibleProjects = query ? projects.filter((p) => p.name.toLowerCase().includes(query)) : projects;
  const selectedName = selectedId
    ? accountProjectsStore.projectOfLocal(selectedId)?.name || projectDisplayName(getProjectStore(selectedId))
    : null;
  const displayName = selectedId ? (selectedName || translate('task.projectFallbackName')) : null;
  const twins = nameTwinIds(projects.map((p) => ({ id: p.chatId, name: p.name })));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={sessionComposerTrayTriggerClassName}>
            <Folder className="size-3 shrink-0" />
            <span className="max-w-[240px] truncate">{selectedId ? displayName : translate('task.projectNone')}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        }
      />
      {/* 三段式:搜索框 → 项目列表 → 分隔线 + 新建项目(带 › 进二级)。 */}
      {/* 向上展开(owner #11):选择器是贴在 composer 顶边的 tab,向下会盖住输入框 → side=top
          让菜单往上开、露出 composer;空间不够时 Base UI Positioner 自动翻回下方。 */}
      <DropdownMenuContent side="top" className="min-w-64 p-0">
        {unavailableHint ? (
          <div className="px-3 py-2 text-xs text-foreground-muted">{unavailableHint}</div>
        ) : (
          <>
            <MenuSearch
              value={projectQuery}
              onChange={setProjectQuery}
              placeholder={translate('task.projectSearchPlaceholder')}
              className="top-0"
            />
            <div className="max-h-64 overflow-y-auto py-1">
              {allowNone ? (
                <DropdownMenuItem onClick={() => onSelect(undefined)}>
                  <X className="size-3.5" />
                  <span>{translate('task.projectSkip')}</span>
                </DropdownMenuItem>
              ) : null}
              {/* 读不到:一行读不到 + 重试,下面仍列上次读到的那份(与侧栏同一个样子)。 */}
              <AccountProjectsError className="px-3 py-2 text-xs" />
              {visibleProjects.length === 0 && projects.length > 0 ? (
                <div className="px-3 py-2 text-xs text-foreground-muted">
                  {translate('task.projectNoMatch')}
                </div>
              ) : null}
              {visibleProjects.map((p) => (
                <AccountProjectItem key={p.chatId} project={p} twin={twins.has(p.chatId)} onSelect={onSelect} />
              ))}
            </div>
            <NewProjectSubmenu onProjectReady={onSelect} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/**
 * 选择器里的一个项目:这一端项目表里有它的本地项目 = 选它的代表(去项目块);一个都没有 = › 里给它挂第一个文件夹。
 */
const AccountProjectItem = observer(function AccountProjectItem({
  project,
  twin,
  onSelect,
}: {
  project: AccountProject;
  twin: boolean;
  onSelect: (projectId: string) => void;
}) {
  const representative = accountProjectsStore.representativeOf(project.chatId);
  if (!representative) return <FolderlessProjectItem project={project} onProjectReady={onSelect} />;
  // 同名的两个项目带上代表那一个的路径区分,与侧栏同一个判据;不同名不带。
  const path = twin ? getProjectStore(representative)?.data?.path : undefined;
  return (
    <DropdownMenuItem onClick={() => onSelect(representative)} title={path} data-chat-id={project.chatId}>
      <Folder className="size-3.5" />
      <span className="truncate">{project.name || projectDisplayName(getProjectStore(representative)) || representative}</span>
      {path ? <small className="ml-auto min-w-0 max-w-[55%] shrink truncate pl-3 text-foreground-passive">{path}</small> : null}
    </DropdownMenuItem>
  );
});

/** 菜单底部「新建项目 ›」:新建空白项目 / 使用现有文件夹(本机,或其他机器上的文件夹 ›)。 */
function NewProjectSubmenu({ onProjectReady }: { onProjectReady: (projectId: string) => void }) {
  const { translate } = useSessionMessages();
  return (
    <div className="border-t border-border py-1">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="project-create-menu">
          <Plus className="size-3.5" />
          <span>{translate('task.projectNew')}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-52">
          <ProjectCreationMenuItems onProjectReady={onProjectReady} />
          <RemoteProjectMenuItems />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </div>
  );
}
