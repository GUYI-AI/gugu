import { observer } from 'mobx-react-lite';
import { PageLoading } from '@/lib/loading/PageLoading';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';

/**
 * In a slot an App's page is drawn over (the resident layer keeps that page clear until its first paint): the loading
 * mark, until the page drawn there has painted — the same key the layer keeps it under (`residentPlace` of the claim).
 */
export const UntilPagePainted = observer(function UntilPagePainted({ kind, place }: { kind: string; place: Parameters<typeof residentPlace>[0] }) {
  return extensionViewStore.paintedPages.has(residentPageKey(kind, residentPlace(place))) ? null : <PageLoading />;
});
