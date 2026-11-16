import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { marketRefreshedChannel } from '@shared/extensions/marketEvents';
import { LOCAL_HOST, marketUpdates } from './installed-extensions';
import { featuredShot, keepShelfButtonsCurrent } from './market-replicas';
import { decodeShot } from './panel/decoded-shots';

/** `marketUpdates('local')` follows the market catalog in hand: read at start and whenever a fetch changed it. ❌ 轮询。 */
export function wireMarketRefresh(): void {
  onMachineEvent(null, marketRefreshedChannel, (refreshed) => {
    if (refreshed.outcome === 'changed') void marketUpdates.refresh(LOCAL_HOST);
  });
  void marketUpdates.refresh(LOCAL_HOST);
  keepShelfButtonsCurrent();
  // The featured pictures kept from the last run, decoded now: opening App after a restart draws the picture in its first
  // frame (a warm-up only; one that fails is the card's own read).
  for (const entry of featuredShot.entries()) {
    if (entry.reading.state === 'value' && entry.reading.value) void decodeShot(entry.reading.value.src).catch(() => undefined);
  }
  void rpc.extensions.marketRefresh().catch((error: unknown) => {
    log.warn('App market refresh at startup not asked:', error);
  });
}
