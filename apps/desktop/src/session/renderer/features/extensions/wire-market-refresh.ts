import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { marketRefreshedChannel } from '@shared/extensions/marketEvents';
import { LOCAL_HOST, marketUpdates } from './installed-extensions';

/** `marketUpdates('local')` follows the market catalog in hand: read at start and whenever a fetch changed it. ❌ 轮询。 */
export function wireMarketRefresh(): void {
  onMachineEvent(null, marketRefreshedChannel, (refreshed) => {
    if (refreshed.outcome === 'changed') void marketUpdates.refresh(LOCAL_HOST);
  });
  void marketUpdates.refresh(LOCAL_HOST);
  void rpc.extensions.marketRefresh().catch((error: unknown) => {
    log.warn('App market refresh at startup not asked:', error);
  });
}
