import { observer } from 'mobx-react-lite';
import { FolderClosed } from '@/lib/icons';
import { Chip } from '@/components/ui/Chip';
import { isScreenView, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { SampleNewProjectButton } from '@renderer/features/sample-project/sample-new-project-button';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { SampleProjectRowMenu } from '@renderer/features/sample-project/sample-project-row-menu';
import { sampleProjectContent } from '@renderer/features/sample-project/use-sample-project';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sampleProjectLastLine } from '@/lib/sidebarOneList';
import { OneListProjectRow, ProjectRowTitle } from './project-row-parts';
import { SidebarMenuAction, SidebarMenuRow, sidebarGroupInsetX } from './sidebar-primitives';
import { sidebarRowContentInsetPx, sidebarRowInsetPx } from './sidebar-row-metrics';
import { SidebarTwistyLane } from './sidebar-twisty';

/**
 * 项目列表最后:示例项目那一行(#709,账号上的键说它在才有),和用户自己一个项目都没有时那一句空状态。
 * 那一行和项目行同一套列(车道、文件夹、名字),名字后面一枚「示例」;点它马上打开那一块 —— 内容在包里,❌ 读网络。
 */
export const SampleProjectSidebar = observer(function SampleProjectSidebar({ rowOnly = false }: {
  /**
   * #2548 the sidebar as one list: only the sample row, drawn as the project group's conversation row it stands for
   * (OneListSampleRow); the no-projects line belongs to the old 「项目」 section.
   */
  rowOnly?: boolean;
}) {
  const { translate } = useSessionMessages();
  const sample = useSampleProject();
  const empty = !rowOnly && sidebarStore.sidebarProjects.length === 0;
  if (rowOnly) {
    return sample.shown && sample.owner ? (
      <SampleProjectRowMenu userId={sample.owner.id}><OneListSampleRow ownerName={sample.owner.name} /></SampleProjectRowMenu>
    ) : null;
  }
  return (
    <>
      {/* 和项目行同一层列表留白(虚拟列表里那一层),选中底色才和项目行一样收在两边。 */}
      {sample.shown && sample.owner ? (
        <div className={sidebarGroupInsetX}>
          <SampleProjectRowMenu userId={sample.owner.id}><SampleProjectRow /></SampleProjectRowMenu>
        </div>
      ) : null}
      {empty && sample.settled ? (
        <div className="flex flex-col items-start gap-2 py-2 pr-3" style={{ paddingInlineStart: `${sidebarRowContentInsetPx('project')}px` }} data-projects-empty="">
          <p className="m-0 text-sm text-foreground-muted">{translate(sample.shown ? 'projects.sample.emptyWithSample' : 'projects.sample.empty')}</p>
          <SampleNewProjectButton />
        </div>
      ) : null}
    </>
  );
});

/** The sample's row is lit while its block is the one being looked at. */
function sampleRowActive(): boolean {
  const focused = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  return focused?.kind === 'sample-project' && isScreenView(appState.navigation.currentViewId);
}

/** Open the sample's block; ⌘ 点 = 拼到正看着那块右边,和项目行同一个手势。 */
function openSampleProject(beside: boolean): void {
  if (beside && isScreenView(appState.navigation.currentViewId)) showBesideOnScreen({ kind: 'sample-project' });
  else showOnScreen({ kind: 'sample-project' });
}

/**
 * #2548 the sample in the one list, as any project group's row: the project cover, its name, then 「示例」 and the
 * transcript's last message (`<sender>: <text>`) with its time. The cover's colour is keyed by the sample's block kind:
 * the sample is no local project, so it has no project id of its own.
 */
const OneListSampleRow = observer(function OneListSampleRow({ ownerName }: { ownerName: string }) {
  const { translate, locale } = useSessionMessages();
  const name = translate('projects.sample.name');
  const { preview, time } = sampleProjectLastLine(sampleProjectContent(locale), ownerName);
  return (
    <OneListProjectRow
      name={name}
      coverId="sample-project"
      tag={translate('projects.sample.tag')}
      time={time}
      preview={preview}
      selected={sampleRowActive()}
      onOpen={openSampleProject}
      aria-label={translate('sidebar.openProject', { project: name })}
      data-tour="sample-project"
      data-sample-project-row=""
    />
  );
});

const SampleProjectRow = observer(function SampleProjectRow() {
  const { translate } = useSessionMessages();
  const name = translate('projects.sample.name');
  const active = sampleRowActive();
  const open = openSampleProject;
  return (
    <SidebarMenuRow
      className="group/row flex h-9 items-center justify-between gap-1 pr-1"
      style={{ paddingInlineStart: `${sidebarRowInsetPx('project')}px` }}
      data-active={active || undefined}
      isActive={active}
      data-tour="sample-project"
      tabIndex={0}
      role="treeitem"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => open(event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open(false);
      }}
    >
      <SidebarTwistyLane expanded={false} label={name} />
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <FolderClosed className="size-4 shrink-0" />
        <SidebarMenuAction aria-label={translate('sidebar.openProject', { project: name })} className="truncate font-medium transition-colors select-none">
          <ProjectRowTitle name={name} keepChildren>
            <Chip>{translate('projects.sample.tag')}</Chip>
          </ProjectRowTitle>
        </SidebarMenuAction>
      </div>
    </SidebarMenuRow>
  );
});
