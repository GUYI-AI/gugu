import { observer } from 'mobx-react-lite';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { readShellSlots } from '@/lib/shellSlots';
import { ONE_LIST_PROJECT_SLOT_PREFIX } from '@/lib/sidebarChatsBridge';
import { oneListTail } from '@/lib/sidebarOneList';
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
 * project groups and people (lib/sidebarOneList). An account project whose project group is not in the chat list yet has
 * no conversation: it stands among the conversation rows at the time its group's row will have, in an element the chat
 * list leaves there (a shell slot, ONE_LIST_PROJECT_SLOT_PREFIX), and is drawn into it as the conversation row it stands for. A standalone
 * task whose session has no 咕咕 identity, and the sample project, come after every conversation row (oneListTail), so
 * none of them goes missing. The conversation rows are walked by the chat list itself (⌘↑/⌘↓). When the account project
 * list cannot be read, the list ends with that line and its retry (the projects it still shows are the last ones read);
 * collapsed, the rail has no room for it.
 */
const NO_SLOTS: ReadonlyMap<string, HTMLElement> = new Map();

export const SidebarOneList = observer(function SidebarOneList() {
  const sample = useSampleProject();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const slots = readShellSlots();
  const shellSlots = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => {}),
    () => slots?.getSlots() ?? NO_SLOTS
  );
  const tail = oneListTail(sidebarStore.tasksWithoutAgent, sample.shown && sample.owner !== null);
  const readError = isLeftOpen && accountProjectsStore.status === 'error';
  return (
    <>
      <SidebarChatsSection />
      {[...shellSlots].map(([key, element]) => {
        if (!key.startsWith(ONE_LIST_PROJECT_SLOT_PREFIX)) return null;
        const chatId = key.slice(ONE_LIST_PROJECT_SLOT_PREFIX.length);
        // The chat list placed it from the same account project list; a project that has just left that list leaves its
        // place on the chat list's next render.
        const project = sidebarStore.sidebarProjects.find((ref) => ref.chatId === chatId);
        return project ? createPortal(<SidebarProjectItem projectId={project.id} />, element, key) : null;
      })}
      {tail.length > 0 || readError ? (
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
          {readError ? <AccountProjectsError className="px-2 py-2 text-xs" /> : null}
        </div>
      ) : null}
    </>
  );
});
