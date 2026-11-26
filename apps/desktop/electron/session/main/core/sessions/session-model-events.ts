import { log } from '@main/lib/logger';

/**
 * #3938 Host-side readers of「this session's model may have changed」: the record changed (a live switch, a reload with
 * another model) or the runtime reported on the session (it came up, the harness switched on its own). `events` only
 * reaches renderers. The reader asks `sessionModelName` again — this says nothing about what the model now is.
 */
const subscribers = new Set<(sessionId: string) => void>();

/** Returns the unsubscribe. */
export function onSessionModelChanged(cb: (sessionId: string) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function announceSessionModelChanged(sessionId: string): void {
  for (const cb of [...subscribers]) {
    try {
      cb(sessionId);
    } catch (error) {
      // One reader's fault neither stops the next nor goes unheard.
      log.error('session model change reader threw', { sessionId, error: String(error) });
    }
  }
}
