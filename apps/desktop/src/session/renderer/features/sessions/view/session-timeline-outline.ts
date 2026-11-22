import { useEffect, useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { TimelineOutlineTurn } from './session-timeline-turns';

/**
 * @@@rail-covers-the-whole-conversation — the outline of the turns a window has not loaded, one per conversation,
 * shared by everything that draws from it (the rail, and the column that reserves the rail's lane).
 *
 * History loads a page at a time from the newest end, so a rail drawn from loaded turns alone ends where the pages
 * end. The outline is asked for once the first page is in, for everything older than it; pages that load later are
 * drawn from their own turns and simply cover the outline's newest entries. It is asked for again only if the loaded
 * history starts later than the outline ends (the transcript was released and read anew).
 *
 * A machine that cannot answer (an older build on the other end of a device link) leaves the rail as it was: this is
 * something more to show, never something the transcript waits for.
 */
type Entry = { before: string; turns: readonly TimelineOutlineTurn[]; asking: boolean };
const KEPT_CONVERSATIONS = 8;
const NONE: readonly TimelineOutlineTurn[] = [];
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function ensureOutline(sessionId: string, oldestLoaded: string): void {
  const entry = entries.get(sessionId);
  // Asked for this stretch, or the loaded turns start inside what the outline covers (older pages loaded since).
  if (entry && (entry.before === oldestLoaded || entry.turns.some(turn => turn.id === oldestLoaded))) return;
  const next: Entry = { before: oldestLoaded, turns: entry?.turns ?? NONE, asking: true };
  entries.delete(sessionId);
  entries.set(sessionId, next);
  for (const oldest of entries.keys()) {
    if (entries.size <= KEPT_CONVERSATIONS) break;
    entries.delete(oldest);
  }
  void rpc.sessions.getOutline({ sessionId, beforeTurnId: oldestLoaded }).then(
    (outline) => {
      if (entries.get(sessionId) !== next) return;
      entries.set(sessionId, { before: oldestLoaded, turns: outline.turns, asking: false });
      publish();
    },
    // Not asked again for this stretch: the rail keeps what it has.
    () => {
      if (entries.get(sessionId) === next) entries.set(sessionId, { ...next, asking: false });
    },
  );
}

/** The outline of `sessionId`'s turns older than the turn `oldestLoaded`, once it is known. Nothing while there is nothing older. */
export function useOutline(sessionId: string | undefined, oldestLoaded: string | undefined, hasOlder: boolean): readonly TimelineOutlineTurn[] {
  useEffect(() => {
    if (sessionId && hasOlder && oldestLoaded !== undefined) ensureOutline(sessionId, oldestLoaded);
  }, [sessionId, oldestLoaded, hasOlder]);
  return useSyncExternalStore(subscribe, () => (sessionId ? entries.get(sessionId)?.turns : undefined) ?? NONE);
}

/** For tests. */
export function resetOutlines(): void {
  entries.clear();
  publish();
}
