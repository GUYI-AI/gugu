import { observer } from 'mobx-react-lite';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { projectsWithoutGroupRow } from '@/lib/sidebarOneList';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarProjectItem } from './project-item';
import { SampleProjectSidebar } from './sample-project-row';
import { SidebarChatsSection } from './sidebar-chats-section';
import { SidebarMenu } from './sidebar-primitives';

/**
 * GUYI-AI/gugu#2548 the left sidebar as one list (internal switch `interface.desktopSidebarV2`): the chat list drawn
 * into its slot holds my standalone agents, groups, project groups and people (lib/sidebarOneList). A project whose
 * project group chat does not exist yet, and the sample project, have no conversation row: they keep their existing
 * project rows right after the list, so nothing disappears while the old sections are hidden.
 */
export const SidebarOneList = observer(function SidebarOneList() {
  const listedGroups = useSidebarChatSignals()?.listedGroups ?? null;
  const groupless = projectsWithoutGroupRow(
    sidebarStore.sidebarProjects.map(({ id }) => id),
    (projectId) => projectGroupsStore.chatIdOf(projectId),
    (projectId) => projectGroupsStore.bindingKnown(projectId),
    listedGroups
  );
  return (
    <>
      <SidebarChatsSection merged={false} unread={0} headerless />
      {groupless.length > 0 && (
        <SidebarMenu className="flex flex-col" data-sidebar-groupless-projects="">
          {groupless.map((projectId) => (
            <SidebarProjectItem key={projectId} projectId={projectId} expandable={false} />
          ))}
        </SidebarMenu>
      )}
      <SampleProjectSidebar rowOnly />
    </>
  );
});
