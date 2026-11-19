import { comparer, reaction } from 'mobx';
import { sidebarFamilies } from './inner-sidebar-scope';

/**
 * Which of my agents is which session, and which of them live in which group (a session's group, `groupChatId`). The
 * writer is here, in the session page; the reader is the chat page (lib/agentSessionsBridge.ts, types and keys only
 * type-imported from here): the profile card's 「发消息」 opens an agent's session, the @ list ranks the group's own agents
 * first.
 *
 * Two trees, one document, each its own bundle: ❌ let the chat page import sidebar stores (it would get a copy that never
 * starts). A window global plus a window event, so whichever side comes up first catches the other.
 */
export const AGENT_SESSIONS_BRIDGE_KEY = '__GUGU_AGENT_SESSIONS__' as const;
export const AGENT_SESSIONS_EVENT = 'gugu:agent-sessions' as const;

export type AgentSessionsBridge = {
  /** Group → my agents whose session lives in it (this computer and every connected machine). */
  readonly groupAgentIds: ReadonlyMap<string, readonly string[]>;
  /** Agent → its session; only agents that are a session on some machine. */
  readonly agentSessions: ReadonlyMap<string, AgentSession>;
};

export type AgentSession = { readonly projectId: string; readonly sessionId: string };

export function publishAgentSessions(groupAgentIds: ReadonlyMap<string, readonly string[]>, agentSessions: ReadonlyMap<string, AgentSession>): void {
  if (typeof window === 'undefined') return;
  const bridge: AgentSessionsBridge = { groupAgentIds, agentSessions };
  (window as unknown as Record<string, unknown>)[AGENT_SESSIONS_BRIDGE_KEY] = bridge;
  window.dispatchEvent(new Event(AGENT_SESSIONS_EVENT));
}

/**
 * Publish from the sidebar's sessions (this computer and every machine, sidebarFamilies): each agent's session, and per
 * group the agents whose session lives in it. Called once when the session page starts (idempotent).
 */
let started = false;
export function startAgentSessionsBridge(): void {
  if (started) return;
  started = true;
  reaction(
      () => {
        const groups = new Map<string, Set<string>>();
        const sessions: [string, AgentSession][] = [];
        for (const entry of sidebarFamilies.get().entries) {
          if (!entry.agentUserId) continue;
          sessions.push([entry.agentUserId, { projectId: entry.projectId, sessionId: entry.id }]);
          if (!entry.groupChatId) continue;
          const ids = groups.get(entry.groupChatId) ?? new Set<string>();
          ids.add(entry.agentUserId);
          groups.set(entry.groupChatId, ids);
        }
        return {
          groups: [...groups].map(([chatId, ids]) => [chatId, [...ids].sort()] as const).sort(([a], [b]) => a.localeCompare(b)),
          sessions: sessions.sort(([a], [b]) => a.localeCompare(b)),
        };
      },
      ({ groups, sessions }) => publishAgentSessions(new Map(groups), new Map(sessions)),
      { fireImmediately: true, equals: comparer.structural },
  );
}
