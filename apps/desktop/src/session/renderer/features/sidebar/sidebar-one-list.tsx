import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { oneListTail, projectsWithoutGroupRow } from '@/lib/sidebarOneList';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarProjectItem } from './project-item';
import { SampleProjectSidebar } from './sample-project-row';
import { SidebarChatsSection } from './sidebar-chats-section';

/**
 * GUYI-AI/gugu#2548 the left sidebar as one list (internal switch `interface.desktopSidebarV2`): the chat list drawn
 * into its slot holds my standalone agents, groups, project groups and people (lib/sidebarOneList). A local project
 * whose project group chat does not exist yet, and the sample project, have no conversation: they are drawn as the
 * conversation rows they stand for (OneListProjectRow), after every conversation row (oneListTail), so nothing
 * disappears while the old sections are hidden. The task page's keyboard chain holds those project rows and nothing
 * hidden (sidebarStore.oneListProjects); the conversation rows are walked by the chat list itself.
 */
export const SidebarOneList = observer(function SidebarOneList() {
  const listedGroups = useSidebarChatSignals()?.listedGroups ?? null;
  const sample = useSampleProject();
  const groupless = projectsWithoutGroupRow(
    sidebarStore.sidebarProjects.map(({ id }) => id),
    (projectId) => projectGroupsStore.chatIdOf(projectId),
    (projectId) => projectGroupsStore.bindingKnown(projectId),
    listedGroups
  );
  const grouplessKey = groupless.join('\n');
  useEffect(() => {
    sidebarStore.setOneListProjects(grouplessKey ? grouplessKey.split('\n') : []);
  }, [grouplessKey]);
  useEffect(() => () => sidebarStore.setOneListProjects(null), []);
  const tail = oneListTail(groupless, sample.shown && sample.owner !== null);
  return (
    <>
      <SidebarChatsSection merged={false} unread={0} headerless />
      {tail.length > 0 && (
        // The chat list ends in its 8px bottom padding; these rows continue it (-mt-2), then end the same way.
        <div className="-mt-2 pb-2" data-sidebar-one-list-tail="">
          {tail.map((row) =>
            row.kind === 'sample' ? (
              <SampleProjectSidebar key="sample" rowOnly />
            ) : (
              <SidebarProjectItem key={row.projectId} projectId={row.projectId} oneList />
            )
          )}
        </div>
      )}
    </>
  );
});
