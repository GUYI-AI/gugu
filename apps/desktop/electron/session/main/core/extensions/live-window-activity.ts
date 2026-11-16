import { liveWindowSourcesChanged } from './live-window-source-changes';

let sequence = 0;
const sessions = new Map<string, Map<string, number>>();

/** Only an admitted Agent App call advances this order. Watching never calls this. */
export function recordLiveWindowActivity(sessionId: string, extensionId: string): void {
  if (extensionId !== 'browser-use' && extensionId !== 'computer-use') return;
  const activity = sessions.get(sessionId) ?? new Map<string, number>();
  activity.set(extensionId, ++sequence);
  sessions.set(sessionId, activity);
  liveWindowSourcesChanged(sessionId);
}

export function liveWindowActivity(sessionId: string, extensionId: string): number | undefined {
  return sessions.get(sessionId)?.get(extensionId);
}
