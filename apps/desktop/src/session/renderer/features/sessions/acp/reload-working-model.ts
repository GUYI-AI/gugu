import type { SessionReloadResponse } from '@/session/shared/core/agents/session-reload';

/** Resume through the existing input queue once the host has applied the change. */
export async function reloadWorkingModel({
  reload,
  turnOutcome,
  continueTurn,
}: {
  reload: () => Promise<SessionReloadResponse>;
  turnOutcome: () => 'done' | 'cancelled' | 'error' | undefined;
  continueTurn: () => void;
}): Promise<SessionReloadResponse> {
  const result = await reload();
  if (result.ok && !result.notStarted && turnOutcome() !== 'done') continueTurn();
  return result;
}
