import { events } from '@renderer/lib/ipc';
import { queryClient } from '@/lib/readModel';
import { shouldInvalidatePrListQuery } from '@renderer/lib/should-invalidate-pr-list-query';
import { prSyncProgressChannel } from '@shared/core/pull-requests/prEvents';

export function wirePrCacheInvalidation(): void {
  events.on(prSyncProgressChannel, (progress) => {
    void queryClient.invalidateQueries({
      predicate: (query) => shouldInvalidatePrListQuery(query.queryKey, progress),
    });
  });
}
