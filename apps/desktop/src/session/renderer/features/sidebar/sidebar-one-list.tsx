import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useSidebarChatSignals, type SidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { oneListTail, projectsWithoutGroupRow } from '@/lib/sidebarOneList';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarProjectItem } from './project-item';
import { SampleProjectSidebar } from './sample-project-row';
import { SidebarChatsSection } from './sidebar-chats-section';

/**
 * GUYI-AI/gugu#2548 the left sidebar as one list: the chat list drawn into its slot holds my standalone agents, groups,
 * project groups and people (lib/sidebarOneList). A local project whose project group chat does not exist yet, and the
 * sample project, have no conversation: they are drawn as the conversation rows they stand for (OneListProjectRow), after
 * every conversation row (oneListTail), so none of them goes missing. The task page's keyboard chain holds those project
 * rows (sidebarStore.oneListProjects); the conversation rows are walked by the chat list itself.
 */
/**
 * The 「对话」 header's number: the unread counts of the conversations (chatsUnread) and of the project groups
 * (groupUnread) added up, because the one list holds both. Same counting rules, same red count (SidebarUnreadCount); the notification model is
 * today's (owner, #2548 A8).
 */
export function oneListUnread(signals: SidebarChatSignals | null): number {
  if (!signals) return 0;
  let total = signals.chatsUnread;
  for (const count of signals.groupUnread.values()) total += count;
  return total;
}

export const SidebarOneList = observer(function SidebarOneList() {
  const signals = useSidebarChatSignals();
  const listedGroups = signals?.listedGroups ?? null;
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
      <SidebarChatsSection unread={oneListUnread(signals)} />
      {tail.length > 0 && (
        // The chat list ends in its 8px bottom padding; these rows continue it (-mt-2), then end the same way.
        <div className="-mt-2 pb-2" data-sidebar-one-list-tail="">
          {tail.map((row) =>
            row.kind === 'sample' ? (
              <SampleProjectSidebar key="sample" />
            ) : (
              <SidebarProjectItem key={row.projectId} projectId={row.projectId} />
            )
          )}
        </div>
      )}
    </>
  );
});
