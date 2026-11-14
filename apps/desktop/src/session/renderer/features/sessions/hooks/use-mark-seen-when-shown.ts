import { useEffect } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { rendererLogger } from '@/lib/log';

/**
 * 「看见即已读」: a session's unread / needs-you state is cleared only while it is actually on screen.
 * Retained session pages stay mounted while hidden (@@@retained-session-pages), so being mounted is not
 * being seen — callers pass whether this session is on screen.
 */
export function useMarkSeenWhenShown(
  session: { seen: boolean; markSeen: () => void | Promise<boolean> } | null | undefined,
  shown: boolean,
  sessionId?: string,
): void {
  const seen = session?.seen;
  useEffect(() => {
    if (!shown || session?.seen || !session && !sessionId) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const mark = async () => {
      if (!active) return;
      let accepted: boolean | void;
      try {
        // A native/remote transcript may be shown before the legacy session registry has its store.
        // Opening still acknowledges the host's error; loading a second renderer store is not a prerequisite.
        accepted = session ? await session.markSeen() : (await rpc.sessions.markSessionSeen(sessionId!), true);
      } catch (error) {
        rendererLogger('session/read').warn({ sessionId, error: String(error) }, 'Session status could not be acknowledged');
        accepted = false;
      }
      if (active && (accepted === false || accepted === true && session && !session.seen)) retry = setTimeout(() => { void mark(); }, 1000);
    };
    void mark();
    return () => { active = false; clearTimeout(retry); };
  }, [shown, session, seen, sessionId]);
}
