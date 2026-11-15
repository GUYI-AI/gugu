import type { ChatSummary } from '@/lib/chatSummariesBridge';
import type { OneListAgentRows } from '@/lib/innerSidebarBridge';
import { myAgentsInChat, subAgentsOf, type AgentFamilies, type ChatAgentEntry, type ChatAgentScope } from './chat-agents';
import type { InnerSidebarAnchor, InnerSidebarAgentAnchor, InnerSidebarRoomAnchor } from './inner-sidebar-anchor';

/**
 * 这一列「智能体」里的那些:群 / 项目里我的智能体,或一个独立智能体的子智能体(#2574;一个列表不再把它画成自己一行,
 * 这一列也就不在了)。
 */
export function columnAgents(
  anchor: InnerSidebarAnchor,
  families: AgentFamilies,
  summaries: ReadonlyMap<string, ChatSummary>,
  agentRows: OneListAgentRows | null,
  scope: (anchor: InnerSidebarRoomAnchor, summaries: ReadonlyMap<string, ChatSummary>) => ChatAgentScope
): ChatAgentEntry[] {
  if (anchor.kind !== 'agent') return myAgentsInChat(families.entries, scope(anchor, summaries));
  return agentRows?.get(anchor.agentUserId)?.chatId === anchor.chatId ? subAgentsOf(families, anchor.agentUserId) : [];
}

/**
 * #2574 这条会话开出来的那个独立智能体的一列:这条会话是它自己的一条顶层会话(❌ 它挂在别人树下的分身)、一个列表把它画成了
 * 自己一行(OneListAgentRows:「有自己一行」只有列表那一份判法,❌ 这里再推一遍)、它至少有一个子智能体;否则 null(照今天的样子开)。
 */
export function standaloneAgentAnchor(sessionId: string, families: AgentFamilies, agentRows: OneListAgentRows | null): InnerSidebarAgentAnchor | null {
  const entry = families.byId.get(sessionId);
  const agentUserId = entry && !entry.parentSessionId ? entry.agentUserId : undefined;
  const row = agentUserId ? agentRows?.get(agentUserId) : undefined;
  if (!agentUserId || !row || subAgentsOf(families, agentUserId).length === 0) return null;
  return { kind: 'agent', chatId: row.chatId, agentUserId };
}

