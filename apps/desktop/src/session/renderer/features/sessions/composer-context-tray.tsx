// gugu #2525: 共享 Session Composer 的「创建上下文」托盘 —— 群 · 设备 · 文件夹三个按需披露的选择器。
// 设备那一格是全 app 共用的机器选择器(remote-hosts/machine-picker 的 compact 尺寸),这里放群选择器。
//
// 规范（#2505 product spec §共享创建器 / §设备与项目默认值）要求各创建入口复用同一套创建能力，
// 所以托盘控件抽在这里共用：新建页 new-session-page.tsx、群页、对话里派任务都用它。
// 群选择器列的是挂了文件夹的群(我各台机器上的,账号上记着的也算),在哪台跑由机器选择器定。
// ❌ 不各写一份：两份一旦分叉，「记住最近一次选择」就会在两个入口给出不同答案。
import { nameTwinIds } from '@renderer/features/projects/name-twins';
import { ChevronDown, Folder, Plus, Users, X } from '@/lib/icons'
import { MenuSearch } from '@/components/ui/Menu'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { ProjectCreationMenuItems } from '@renderer/features/projects/components/project-creation-menu-items';
import { RemoteProjectMenuItems } from '@renderer/features/sidebar/remote-project-menu-items';
import { ProjectPickerItem } from '@renderer/features/projects/components/project-picker-item';
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store';
import { GroupFoldersError } from '@renderer/features/folders/group-folders-error';
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
  /** The group chosen (chat id); none = a task in no group. */
  selectedId: string | undefined;
  onSelect: (chatId: string | undefined) => void;
  /** 非空 = 所选设备的列表读不到，展示这句话而不是一份不属于它的列表。 */
  unavailableHint?: string | null;
  /** 群页:这一页就是某个群的,没有「不选群」这一项。 */
  allowNone?: boolean;
}) {
  const { translate } = useSessionMessages();
  const groups = groupFoldersStore.groups;
  const [projectQuery, setProjectQuery] = useState('');
  // 搜索按群名过滤。
  const query = projectQuery.trim().toLowerCase();
  const visibleGroups = query ? groups.filter((group) => group.name.toLowerCase().includes(query)) : groups;
  const selectedName = selectedId
    ? groups.find((group) => group.chatId === selectedId)?.name || readChatSummary(selectedId)?.name
    : null;
  const displayName = selectedId ? (selectedName || translate('task.projectFallbackName')) : null;
  const twins = nameTwinIds(groups.map((group) => ({ id: group.chatId, name: group.name })));

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
      {/* 三段式:搜索框 → 群列表 → 分隔线 + 新建群(带 › 进二级)。 */}
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
              <GroupFoldersError className="px-3 py-2 text-xs" />
              {visibleGroups.length === 0 && groups.length > 0 ? (
                <div className="px-3 py-2 text-xs text-foreground-muted">
                  {translate('task.projectNoMatch')}
                </div>
              ) : null}
              {visibleGroups.map((group) => (
                <ProjectPickerItem key={group.chatId} group={group} twin={twins.has(group.chatId)} onSelect={onSelect} />
              ))}
            </div>
            <NewProjectSubmenu onProjectReady={onSelect} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** 菜单底部「新建群 ›」:新建群(同时新建一个文件夹)/ 用现有文件夹新建群(本机,或其他机器上的文件夹 ›)。 */
function NewProjectSubmenu({ onProjectReady }: { onProjectReady: (chatId: string) => void }) {
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
