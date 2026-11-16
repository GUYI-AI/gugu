import { log } from '@main/lib/logger';
const listeners = new Map<string, Set<() => void>>();

/** Metadata only. Pictures remain on their existing exact-recipient projection watch. */
export function liveWindowSourcesChanged(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) {
    try { listener(); } catch (error) { log.warn('Live picture metadata observer failed', { error: String(error) }); }
  }
}
export function observeLiveWindowSources(sessionId: string, listener: () => void): () => void {
  const group = listeners.get(sessionId) ?? new Set<() => void>();
  group.add(listener); listeners.set(sessionId, group);
  return () => { group.delete(listener); if (!group.size) listeners.delete(sessionId); };
}
