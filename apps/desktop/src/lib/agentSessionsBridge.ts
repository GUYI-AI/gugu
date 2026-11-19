// Which of my agents is which session, and which live in which group: the chat page's read end. The writer is in the session
// page (session/renderer/features/sidebar/agent-sessions-bridge.ts); types, key and event name are only type-imported or
// copied from it. ❌ a new IPC bridge.
import { useSyncExternalStore } from 'react'
import type {
  AGENT_SESSIONS_BRIDGE_KEY as WriterKey,
  AGENT_SESSIONS_EVENT as WriterEvent,
  AgentSessionsBridge,
  AgentSession,
} from '@/session/renderer/features/sidebar/agent-sessions-bridge'

const BRIDGE_KEY = '__GUGU_AGENT_SESSIONS__' satisfies typeof WriterKey
const EVENT = 'gugu:agent-sessions' satisfies typeof WriterEvent
const NO_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map()
const NO_SESSIONS: ReadonlyMap<string, AgentSession> = new Map()

/** Bridge absent = the session bundle is not up yet (or this is not the desktop): nothing known. Malformed = the two builds drifted: throw. */
function readBridge(target: Window | undefined): Partial<AgentSessionsBridge> | null {
  if (!target) return null
  const candidate = (target as unknown as Record<string, unknown>)[BRIDGE_KEY]
  if (!candidate) return null
  const bridge = candidate as Partial<AgentSessionsBridge>
  if (!(bridge.groupAgentIds instanceof Map) || !(bridge.agentSessions instanceof Map)) throw new Error('agent sessions bridge is present but malformed')
  return bridge
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** My agents whose session lives in each group, by group. */
export function readGroupAgents(target: Window | undefined = typeof window === 'undefined' ? undefined : window): ReadonlyMap<string, readonly string[]> {
  return readBridge(target)?.groupAgentIds ?? NO_MEMBERS
}

export function useGroupAgents(): ReadonlyMap<string, readonly string[]> {
  return useSyncExternalStore(subscribe, () => readGroupAgents(), () => NO_MEMBERS)
}

/** This agent's session on whichever machine; not a session anywhere (or the bridge not up yet) = undefined. */
export function useAgentSession(agentUserId: string | null): AgentSession | undefined {
  const sessions = useSyncExternalStore(subscribe, () => readBridge(window)?.agentSessions ?? NO_SESSIONS, () => NO_SESSIONS)
  return agentUserId ? sessions.get(agentUserId) : undefined
}
