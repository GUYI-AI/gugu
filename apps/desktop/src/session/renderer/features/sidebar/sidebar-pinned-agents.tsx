import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useChatSummaries } from '@/lib/chatSummariesBridge';
import { publishSidebarPinnedAgents, type SidebarPinnedAgent } from '@/lib/sidebarChatsBridge';
import { chatScope, isProjectChat, listedProjectIds, mySidebarAgents } from './inner-sidebar';
import type { InnerSidebarRoomAnchor } from './inner-sidebar-anchor';
import { sidebarSessionFacts } from './sidebar-pin-actions';
import { pinnedSidebarAgents, sidebarAgentHome, type SidebarHomeCandidate } from './sidebar-pin';

/**
 * #2548 固定到左侧栏: my pinned agents that live in a group or a project, for the top of the one list (the shell draws
 * their DM rows, sidebarChatsBridge). Where each lives = the group / project whose inner column lists it (chatScope,
 * the column's own reading), named as the list names that chat. Draws nothing.
 */
export const PinnedSidebarAgentsPublisher = observer(function PinnedSidebarAgentsPublisher() {
  const summaries = useChatSummaries();
  const homes: (SidebarHomeCandidate & { chatId: string })[] = [];
  const projects = listedProjectIds();
  for (const [chatId, summary] of summaries) {
    if (summary.kind !== 'group' || !summary.name) continue;
    // Same reading as the inner column's anchor: the group of a project the sidebar lists is that project.
    const anchor: InnerSidebarRoomAnchor = { kind: isProjectChat(chatId) ? 'project' : 'group', chatId };
    homes.push({ kind: anchor.kind, name: summary.name, chatId, scope: chatScope(anchor, summaries, projects) });
  }
  const sessions = mySidebarAgents().map((entry) => ({ ...entry, sessionId: entry.id, ...sidebarSessionFacts(entry.projectId, entry.id) }));
  // A session with no 咕咕 identity yet has no DM to draw: it is not on the list.
  const rows: SidebarPinnedAgent[] = pinnedSidebarAgents(sessions, (session) => sidebarAgentHome(session, homes)).flatMap(
    ({ session, home }) =>
      session.agentUserId
        ? [{ agentUserId: session.agentUserId, sessionId: session.id, home: { kind: home.kind, name: home.name, chatId: home.chatId } }]
        : []
  );
  // 依赖是序列化后的那一份:每次渲染新建的数组不算变化(publish 自己也只在变了时才通知)。
  const key = JSON.stringify(rows);
  useEffect(() => publishSidebarPinnedAgents(rows), [key]);
  return null;
});
