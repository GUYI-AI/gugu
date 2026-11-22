import { computed } from 'mobx';
import type { ChatSummary } from '@/lib/chatSummariesBridge';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { agentFamilies, myAgentsInChat, type ChatAgentEntry, type ChatAgentScope } from './chat-agents';
import { viewAnchor, type InnerSidebarRoomAnchor } from './inner-sidebar-anchor';

// 哪些智能体住在哪个群里(#2599),以及一屏的入口是哪个群:内层侧栏和导航(从群的屏里点开它的智能体)读同一份。

/** 侧栏里我的每一条会话,带上它背后的 agent(同 SidebarSessionItem 认身份的两条腿)。 */
export function mySidebarAgents(): ChatAgentEntry[] {
  return [...sidebarStore.placement.nodeById.values()].map(({ item }) => ({
    id: item.id,
    projectId: item.projectId,
    parentSessionId: item.parentSessionId,
    time: item.time,
    createdAt: item.createdAt,
    presentation: item.presentation,
    unseen: item.unseen,
    hostOnline: item.hostOnline,
    agentUserId:
      sessionAgentBindings.bindingFor(item.id)?.agentUserId ??
      sidebarStore.remoteSession(item.projectId, item.id)?.summary.agent?.userId,
    bornInChatId: item.bornInChatId ?? null,
    groupChatId: item.groupChatId ?? null,
  }));
}

/** #2599 这个群里住着谁:在这个群里的,或不在任何群里、在这里(或它的一个话题里)建的(chat-agents)。 */
export function chatScope(anchor: InnerSidebarRoomAnchor, summaries: ReadonlyMap<string, ChatSummary>): ChatAgentScope {
  return { here: (chatId) => chatId === anchor.chatId || summaries.get(chatId)?.sourceChatId === anchor.chatId };
}

/** 侧栏里我的会话与它们的父子,数据变了才重编一遍(这一列每次渲染都要读;在跑的 agent 每跳一下状态它就重画一次)。 */
export const sidebarFamilies = computed(() => agentFamilies(mySidebarAgents()));

/**
 * 一屏的入口(screen-layout `entry`,左边那一行的 contentKey)是群:这一屏的内层侧栏挂在它上面 ——
 * 从它里面点开的智能体、切走再回来摆回的那一屏都是。入口是会话、私聊、App = null。
 */
export function roomOfEntry(entry: string | null, summaries: ReadonlyMap<string, ChatSummary>): InnerSidebarRoomAnchor | null {
  const [, id] = /^chat:(.+)$/.exec(entry ?? '') ?? [];
  return id ? viewAnchor({ kind: 'chat', chatId: id, chatKind: summaries.get(id)?.kind ?? null }) : null;
}

/** 这条会话住在这个群里:列在它那一列的「智能体」里。 */
export function roomListsSession(room: InnerSidebarRoomAnchor, sessionId: string, summaries: ReadonlyMap<string, ChatSummary>): boolean {
  return myAgentsInChat(sidebarFamilies.get().entries, chatScope(room, summaries)).some((entry) => entry.id === sessionId);
}
