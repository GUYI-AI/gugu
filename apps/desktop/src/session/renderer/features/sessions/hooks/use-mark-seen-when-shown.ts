import { useEffect } from 'react';

/**
 * 「看见即已读」: a session's unread / needs-you state is cleared only while it is actually on screen.
 * Retained session pages stay mounted while hidden (@@@retained-session-pages), so being mounted is not
 * being seen — callers pass whether this session is on screen.
 */
export function useMarkSeenWhenShown(
  session: { seen: boolean; markSeen: () => void | Promise<boolean> } | null | undefined,
  shown: boolean
): void {
  const seen = session?.seen;
  useEffect(() => {
    if (!shown || !session || session.seen) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const mark = async () => {
      const accepted = await session.markSeen();
      if (active && (accepted === false || accepted === true && !session.seen)) retry = setTimeout(() => { void mark(); }, 1000);
    };
    void mark();
    return () => { active = false; clearTimeout(retry); };
  }, [shown, session, seen]);
}
