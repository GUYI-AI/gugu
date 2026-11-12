import { observer } from 'mobx-react-lite';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { oneListTail, projectsWithoutGroupRow } from '@/lib/sidebarOneList';
import { AccountProjectsError } from '@renderer/features/projects/components/account-projects-error';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { OneListTaskRow } from './one-list-task-row';
import { SidebarProjectItem } from './project-item';
import { SampleProjectSidebar } from './sample-project-row';
import { SidebarChatsSection } from './sidebar-chats-section';

/**
 * GUYI-AI/gugu#2548 the left sidebar as one list: the chat list drawn into its slot holds my standalone agents, groups,
 * project groups and people (lib/sidebarOneList). An account project whose project group is not in the chat list yet, a
 * standalone task whose session has no 咕咕 identity, and the sample project have no conversation: they are drawn as the
 * conversation rows they stand for (OneListRow), after every conversation row (oneListTail), so none of them goes
 * missing. The conversation rows are walked by the chat list itself (⌘↑/⌘↓). When the account project list cannot be
 * read, the list ends with that line and its retry (the projects it still shows are the last ones read); collapsed, the
 * rail has no room for it.
 */
export const SidebarOneList = observer(function SidebarOneList() {
  const signals = useSidebarChatSignals();
  const listedGroups = signals?.listedGroups ?? null;
  const sample = useSampleProject();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const groupless = projectsWithoutGroupRow(sidebarStore.sidebarProjects, listedGroups);
  const tail = oneListTail(groupless, sidebarStore.tasksWithoutAgent, sample.shown && sample.owner !== null);
  const readError = isLeftOpen && accountProjectsStore.status === 'error';
  return (
    <>
      <SidebarChatsSection />
      {tail.length > 0 || readError ? (
        // The chat list ends in its 8px bottom padding; these rows continue it (-mt-2), then end the same way.
        <div className="-mt-2 pb-2" data-sidebar-one-list-tail="">
          {tail.map((row) =>
            row.kind === 'sample' ? (
              <SampleProjectSidebar key="sample" />
            ) : row.kind === 'task' ? (
              <OneListTaskRow key={`task:${row.sessionId}`} projectId={row.projectId} sessionId={row.sessionId} />
            ) : (
              <SidebarProjectItem key={row.projectId} projectId={row.projectId} />
            )
          )}
          {readError ? <AccountProjectsError className="px-5 py-2 text-xs" /> : null}
        </div>
      ) : null}
    </>
  );
});
