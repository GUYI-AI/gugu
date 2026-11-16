import type { Reading } from '@/lib/replica';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
/**
 * Whether the agent list will answer here (a place is held for it): not failed, and its machine connected. #6264 a machine
 * not connected is not asked, so nothing is held for it (why it is unreachable is the machine's notice).
 */
export function agentsAnswerAwaited(reading: Reading<AgentPayload[]>, remote: { online: boolean } | null): boolean {
  return reading.state !== 'error' && remote?.online !== false;
}
