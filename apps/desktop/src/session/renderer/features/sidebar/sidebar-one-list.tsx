import { observer } from 'mobx-react-lite';
import { oneListTail } from '@/lib/sidebarOneList';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { OneListTaskRow } from './one-list-task-row';
import { SampleProjectSidebar } from './sample-project-row';
import { SidebarChatsSection } from './sidebar-chats-section';

/**
 * GUYI-AI/gugu#2548 the left sidebar as one list: the chat list drawn into its slot holds my standalone agents, groups and
 * people (lib/sidebarOneList). A standalone task whose session has no 咕咕 identity, and the sample, come after every
 * conversation row (oneListTail), so none of them goes missing. The conversation rows are walked by the chat list itself
 * (⌘↑/⌘↓).
 */
export const SidebarOneList = observer(function SidebarOneList() {
  const sample = useSampleProject();
  const tail = oneListTail(sidebarStore.tasksWithoutAgent, sample.shown && sample.owner !== null);
  return (
    <>
      <SidebarChatsSection />
      {tail.length > 0 ? (
        // The chat list ends in its 8px bottom padding; these rows continue it (-mt-2), then end the same way, in the
        // chat list's 12px gutter.
        <div className="-mt-2 px-3 pb-2" data-sidebar-one-list-tail="">
          {tail.map((row) =>
            row.kind === 'sample' ? (
              <SampleProjectSidebar key="sample" />
            ) : (
              <OneListTaskRow key={`task:${row.sessionId}`} projectId={row.projectId} sessionId={row.sessionId} />
            )
          )}
        </div>
      ) : null}
    </>
  );
});
