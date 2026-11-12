import { observer } from 'mobx-react-lite';
import { isScreenView, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { SampleProjectRowMenu } from '@renderer/features/sample-project/sample-project-row-menu';
import { sampleProjectInView } from '@renderer/features/sample-project/sample-project-view';
import { sampleProjectContent } from '@renderer/features/sample-project/use-sample-project';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sampleProjectLastLine } from '@/lib/sidebarOneList';
import { OneListProjectRow } from './project-row-parts';

/**
 * 示例项目那一行(#709,账号上的键说它在才有),在一张表里画成它代表的那个项目群的对话行(OneListSampleRow);
 * 点它马上打开那一块 —— 内容在包里,❌ 读网络。
 */
export const SampleProjectSidebar = observer(function SampleProjectSidebar() {
  const sample = useSampleProject();
  return sample.shown && sample.owner ? (
    <SampleProjectRowMenu userId={sample.owner.id}><OneListSampleRow ownerName={sample.owner.name} /></SampleProjectRowMenu>
  ) : null;
});

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
      selected={sampleProjectInView()}
      onOpen={openSampleProject}
      aria-label={translate('sidebar.openProject', { project: name })}
      data-tour="sample-project"
      data-sample-project-row=""
    />
  );
});
