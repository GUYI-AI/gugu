import type { Reading } from '@/lib/replica';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
/** Whether the agent list will answer here (a place is held for it); #6264 a machine not connected is not asked. */
export function agentsAnswerAwaited(reading: Reading<AgentPayload[]>, remote: { online: boolean } | null): boolean {
  return reading.state !== 'error' && remote?.online !== false;
}
