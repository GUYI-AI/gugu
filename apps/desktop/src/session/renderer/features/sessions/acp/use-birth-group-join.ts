import { useCallback, useEffect, useState } from 'react';
import type { SessionShellBirthGroupJoin } from '@shared/lib/ipc/shell-port';
import { findSessionShellPort, onBirthGroupJoinEvent } from '@renderer/lib/shell-port';
import { log } from '@renderer/utils/logger';

/**
 * The birth chat this session's agent could not join (`sessionpage-birth-group-join.ts` on the host), and a retry.
 * Read once when the panel opens, then kept current by the host's event (a failure, or a retry that settled it).
 */
export function useBirthGroupJoin(sessionId: string | undefined): {
  join: SessionShellBirthGroupJoin | null;
  retrying: boolean;
  retry: () => void;
} {
  const [join, setJoin] = useState<SessionShellBirthGroupJoin | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setJoin(null);
    if (!sessionId) return;
    let live = true;
    const off = onBirthGroupJoinEvent((event) => {
      if (event.conversationId === sessionId) setJoin(event.join);
    });
    const port = findSessionShellPort();
    // A shell without this capability answers nothing pending; a failed read is said, not hidden.
    void port?.birthGroupJoin(sessionId).then(
      (current) => { if (live) setJoin(current); },
      (error: unknown) => log.error('Birth group join state could not be read', { sessionId, error }),
    );
    return () => {
      live = false;
      off();
    };
  }, [sessionId]);

  const retry = useCallback(() => {
    const port = findSessionShellPort();
    if (!sessionId || !port || retrying) return;
    setRetrying(true);
    void port.retryBirthGroupJoin(sessionId)
      .then((still) => setJoin(still))
      .catch((error: unknown) => {
        log.error('Birth group join retry failed', { sessionId, error });
        setJoin((current) => current && { ...current, reason: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => setRetrying(false));
  }, [sessionId, retrying]);

  return { join, retrying, retry };
}
