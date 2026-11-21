import { computed } from 'mobx';
import type { ChatSummary } from '@/lib/chatSummariesBridge';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { agentFamilies, myAgentsInChat, type ChatAgentEntry, type ChatAgentScope } from './chat-agents';
import { viewAnchor, type InnerSidebarRoomAnchor } from './inner-sidebar-anchor';

// 哪些智能体住在哪个群 / 项目里(#2599),以及一屏的入口是哪个群 / 项目:内层侧栏和导航(从群的屏里点开它的智能体)读同一份。

/** 侧栏里我的每一条会话,带上它背后的 agent(同 SidebarSessionItem 认身份的两条腿)。 */
export function mySidebarAgents(): ChatAgentEntry[] {
  return [...sidebarStore.placement.nodeById.values()].map(({ item }) => ({
    id: item.id,
    projectId: item.projectId,
    parentSessionId: item.parentSessionId,
    isPinned: item.isPinned,
    time: item.time,
    createdAt: item.createdAt,
    presentation: item.presentation,
    unseen: item.unseen,
    hostOnline: item.hostOnline,
    agentUserId:
      sessionAgentBindings.bindingFor(item.id)?.agentUserId ??
      sidebarStore.remoteSession(item.projectId, item.id)?.summary.agent?.userId,
    bornInChatId: item.bornInChatId ?? null,
  }));
}

/** 这个项目(账号上的项目 = 它的项目群)在各台机器上的本地项目,代表在最前;一个文件夹都没有 = []。 */
function projectIdsOfChat(chatId: string): readonly string[] {
  return accountProjectsStore.membersOf(chatId);
}

/** 这个群是不是侧栏列着的一个项目(账号上的项目,归档的不列):是 = 内层侧栏按项目画它。 */
export function isProjectChat(chatId: string): boolean {
  return accountProjectsStore.projects.some((project) => !project.archived && project.chatId === chatId);
}

/** 侧栏列着的项目(账号上的项目,归档的不列)在各台机器上的本地项目:住在这些里的 agent 住在那个项目,❌ 算在群里。 */
export function listedProjectIds(): ReadonlySet<string> {
  return new Set(sidebarStore.sidebarProjects.flatMap((ref) => projectIdsOfChat(ref.chatId)));
}

/**
 * #2599 这个群 / 项目里住着谁:在这个项目里的,或在这里(或它的一个话题里)建、又不在任何项目里的(chat-agents)。
 * 一次算很多个群 / 项目的(角标、固定的那几行)把 `projects`(listedProjectIds)算一次传进来。
 */
export function chatScope(
  anchor: InnerSidebarRoomAnchor,
  summaries: ReadonlyMap<string, ChatSummary>,
  projects: ReadonlySet<string> = listedProjectIds()
): ChatAgentScope {
  return {
    kind: anchor.kind,
    projectIds: anchor.kind === 'project' ? projectIdsOfChat(anchor.chatId) : [],
    bornHere: (chatId) => chatId === anchor.chatId || summaries.get(chatId)?.sourceChatId === anchor.chatId,
    inProject: (projectId) => projects.has(projectId),
  };
}

/** 侧栏里我的会话与它们的父子,数据变了才重编一遍(这一列每次渲染都要读;在跑的 agent 每跳一下状态它就重画一次)。 */
export const sidebarFamilies = computed(() => agentFamilies(mySidebarAgents()));

/**
 * 一屏的入口(screen-layout `entry`,左边那一行的 contentKey)是群或项目:这一屏的内层侧栏挂在它上面 ——
 * 从它里面点开的智能体、切走再回来摆回的那一屏都是。入口是会话、私聊、App = null。
 */
export function roomOfEntry(entry: string | null, summaries: ReadonlyMap<string, ChatSummary>): InnerSidebarRoomAnchor | null {
  const [, kind, id] = /^(project|chat):(.+)$/.exec(entry ?? '') ?? [];
  if (kind === 'project') return viewAnchor({ kind: 'project', chatId: accountProjectsStore.projectOfLocal(id)?.chatId });
  if (kind === 'chat') return viewAnchor({ kind: 'chat', chatId: id, chatKind: summaries.get(id)?.kind ?? null, projectGroup: isProjectChat(id) });
  return null;
}

/** 这条会话住在这个群 / 项目里:列在它那一列的「智能体」里。 */
export function roomListsSession(room: InnerSidebarRoomAnchor, sessionId: string, summaries: ReadonlyMap<string, ChatSummary>): boolean {
  return myAgentsInChat(sidebarFamilies.get().entries, chatScope(room, summaries)).some((entry) => entry.id === sessionId);
}
