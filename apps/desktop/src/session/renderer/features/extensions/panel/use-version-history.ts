import { useReplica } from '@/lib/replica';
import { messageForUser } from '@/lib/userFacingError';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { MarketVersionHistoryEntry } from '@shared/extensions/market';
import { marketVersionHistory } from '../market-replicas';
import type { Loadable } from './app-version-history';

const said = (error: Error) => error.message === 'history unreadable' ? translateSessionMessage('extensions.historyUnavailable') : messageForUser(error);

/** An App's version history as the detail surfaces draw it: the `marketVersionHistory` reading, read only while `enabled`. */
export function useVersionHistory(hostKey: string, extensionId: string, enabled = true) {
  const reading = useReplica(marketVersionHistory, enabled ? [hostKey, extensionId] : null);
  const state: Loadable<MarketVersionHistoryEntry[]> = !enabled ? { status: 'idle' }
    : reading.state === 'unknown' ? { status: 'loading' }
    : reading.state === 'error' ? { status: 'error', error: said(reading.error) }
    : { status: 'ready', data: reading.value, error: reading.error ? said(reading.error) : undefined };
  return { state, retry: () => { void marketVersionHistory.refresh(hostKey, extensionId); } };
}
