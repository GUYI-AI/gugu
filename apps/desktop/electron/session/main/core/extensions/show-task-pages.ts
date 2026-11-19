import type { BridgeCaller } from './extension-bridge';

type Dependencies = {
  authorize(extensionId: string): void;
  assertTask(sessionId: string): Promise<void>;
  open(target: { sessionId: string }, extensionId: string, signal: AbortSignal): Promise<string[]>;
};

/** Bring up this App's declared per-task pages; the App decides when, the host decides where. */
export async function showTaskPages(caller: BridgeCaller, deps: Dependencies): Promise<string[]> {
  if (caller.kind !== 'program' || !caller.callingSession || !caller.signal) throw new Error('Opening task pages needs a current task program call');
  caller.signal.throwIfAborted(); deps.authorize(caller.extensionId);
  const sessionId = caller.callingSession;
  await deps.assertTask(sessionId);
  caller.signal.throwIfAborted(); deps.authorize(caller.extensionId);
  return deps.open({ sessionId }, caller.extensionId, caller.signal);
}
