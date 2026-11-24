import { useEffect, useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { TimelineOutlineTurn } from './session-timeline-turns';

/**
 * @@@rail-covers-the-whole-conversation — the outline of the turns a window has not loaded, one per conversation,
 * shared by everything that draws from it (the rail, and the column that reserves the rail's lane).
 *
 * History loads a page at a time from the newest end, so a rail drawn from loaded turns alone ends where the pages
 * end. The outline is asked for once the first page is in, for everything older than it; pages that load later are
 * drawn from their own turns and simply cover the outline's newest entries. When the loaded history starts later than
 * the outline ends (the transcript was read anew and its newest page has moved on), only the stretch after the newest
 * outlined turn is asked for: on a long conversation the whole outline is a megabyte. One question per conversation at
 * a time; what lands is checked again against where the loaded history starts by then.
 *
 * A machine that cannot answer (an older build on the other end of a device link) leaves the rail as it was: this is
 * something more to show, never something the transcript waits for.
 */
type Entry = {
  before: string;
  turns: readonly TimelineOutlineTurn[];
  asking: boolean;
  /** Where the loaded history started when it moved while a question was on its way: checked once the answer lands. */
  again?: string;
};
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
  if (entry?.asking) {
    entry.again = oldestLoaded;
    return;
  }
  const held = entry?.turns ?? NONE;
  const after = held.at(-1)?.id;
  const next: Entry = { before: oldestLoaded, turns: held, asking: true };
  entries.delete(sessionId);
  entries.set(sessionId, next);
  for (const oldest of entries.keys()) {
    if (entries.size <= KEPT_CONVERSATIONS) break;
    entries.delete(oldest);
  }
  void rpc.sessions.getOutline({ sessionId, beforeTurnId: oldestLoaded, ...(after === undefined ? {} : { afterTurnId: after }) }).then(
    (outline) => {
      if (entries.get(sessionId) !== next) return;
      // Only the stretch after `after` when the machine says so; otherwise (an older build, or a history that no longer
      // has that turn) the answer is the whole outline and replaces what was held.
      const turns = after !== undefined && outline.after === after ? [...held, ...outline.turns] : outline.turns;
      entries.set(sessionId, { before: oldestLoaded, turns, asking: false });
      publish();
      if (next.again !== undefined) ensureOutline(sessionId, next.again);
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
