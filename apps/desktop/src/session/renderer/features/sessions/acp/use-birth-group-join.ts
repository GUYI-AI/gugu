import { useCallback, useState } from 'react';
import type { SessionShellBirthGroupJoin } from '@shared/lib/ipc/shell-port';
import { findSessionShellPort, onBirthGroupJoinEvent } from '@renderer/lib/shell-port';
import { replica, useReplica } from '@/lib/replica';
import { log } from '@renderer/utils/logger';

/**
 * The birth chat this session's agent could not join (`sessionpage-birth-group-join.ts` on the host): read once per
 * session, then kept current by the host's event (a failure, or a retry that settled it) and by the retry's answer.
 */
const birthGroupJoin = replica<[string], SessionShellBirthGroupJoin | null>({
  name: 'session-birth-group-join',
  scope: 'account',
  // A shell without this capability has nothing pending to say.
  read: async (_owner, sessionId) => (await findSessionShellPort()?.birthGroupJoin(sessionId)) ?? null,
});

onBirthGroupJoinEvent(({ conversationId, join }) => {
  if (birthGroupJoin.key(conversationId)) birthGroupJoin.set([conversationId], join);
});

export function useBirthGroupJoin(sessionId: string | undefined): {
  join: SessionShellBirthGroupJoin | null;
  retrying: boolean;
  retry: () => void;
} {
  const reading = useReplica(birthGroupJoin, sessionId ? [sessionId] : null);
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(() => {
    const port = findSessionShellPort();
    if (!sessionId || !port || retrying) return;
    setRetrying(true);
    const entry = birthGroupJoin.at(sessionId);
    void port.retryBirthGroupJoin(sessionId)
      .then((still) => entry.set(still))
      // The host could not run the retry at all (signed out, host gone): the row stays as it was; the cause goes to the log.
      .catch((error: unknown) => log.error('Birth group join retry failed', { sessionId, error }))
      .finally(() => setRetrying(false));
  }, [sessionId, retrying]);

  return { join: reading.state === 'value' ? reading.value : null, retrying, retry };
}
