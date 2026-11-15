import { useState } from 'react';
import { useReplica } from '@/lib/replica';
import { useLegacyDmOwner } from './useLegacyDmOwner';
import { legacyDmHistoryAvailable } from './legacyDmReplicas';

/**
 * Whether a session's menu offers its old chats. Reading takes a walk over the account's chats, so only a menu
 * that was opened asks. A failed read keeps the entry: the dialog says what went wrong and retries.
 */
export function useLegacyDmHistoryEntry(sessionId: string | undefined) {
  const ownerUserId = useLegacyDmOwner();
  const [asked, setAsked] = useState(false);
  const reading = useReplica(legacyDmHistoryAvailable, asked && ownerUserId && sessionId ? [sessionId] : null);
  return { isAvailable: () => (reading.state === 'value' && reading.value) || reading.state === 'error', onMenuOpen: () => setAsked(true) };
}
