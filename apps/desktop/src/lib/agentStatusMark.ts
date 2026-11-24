import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'

const MARKED: ReadonlySet<AgentDisplayStatus> = new Set(['working', 'parked', 'needs_user', 'error', 'offline'])

/** Whether a state draws a mark at all (AgentContactStatusMark); callers that wrap the mark in a box skip the box otherwise. */
export function agentStatusHasMark(tone: AgentDisplayStatus | null): boolean {
  return tone !== null && MARKED.has(tone)
}
