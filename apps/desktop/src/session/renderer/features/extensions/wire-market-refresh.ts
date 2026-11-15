import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { marketRefreshedChannel } from '@shared/extensions/marketEvents';
import { LOCAL_HOST, marketUpdates } from './installed-extensions';

/**
 * 本机的「有新版 / 被撤回 / 已弃用」(`marketUpdates('local')`)跟着手上那份市场目录走(market-snapshot.ts):启动时先从手上那份
 * 查一次,同时让主进程去下载站取一趟;之后不论哪一趟取回来变了,都再查一次 —— 和市场页读的永远是同一份。❌ 轮询。
 * 读失败落在读数上(角标不画),不吞成「没有更新」。
 */
export function wireMarketRefresh(): void {
  onMachineEvent(null, marketRefreshedChannel, (refreshed) => {
    if (refreshed.outcome === 'changed') void marketUpdates.refresh(LOCAL_HOST);
  });
  void marketUpdates.refresh(LOCAL_HOST);
  void rpc.extensions.marketRefresh().catch((error: unknown) => {
    log.warn('App market refresh at startup not asked:', error);
  });
}
