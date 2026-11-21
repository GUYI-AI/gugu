import { useEffect, useRef, type RefObject } from 'react';
import { readCachedDevices } from '@/store/devicesCache';
import { messageForUser } from '@/lib/userFacingError';
import type { ExtensionsHost } from '@renderer/features/extensions/extensions-host';
import { useInstalledApps } from '@renderer/features/extensions/installed-extensions';
import { marketEntry } from '@renderer/features/extensions/market-replicas';
import type { MarketSubject } from '@renderer/features/settings/components/ExtensionsSettingsCard';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { AppsLocation } from './apps-location';

/**
 * The App page a location names, made drawable: a link names only the App, so this settles which page (its settings
 * when installed here, else its market page) and reads the market page's subject when the list has not got it. A page
 * already settled and drawn asks nothing, so background market refreshes do not reopen a page the person left.
 */
export function useAppDetailRequest({ page, deviceId, ready, host, hasSubject, onPage, onSubject, rootRef }: {
  page: AppsLocation['detail']; deviceId?: string; ready: boolean; host: ExtensionsHost;
  hasSubject: (extensionId: string) => boolean;
  onPage: (page: 'manage' | 'market') => void;
  onSubject: (subject: MarketSubject) => void;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  // What is installed on that host, read when the request is taken (a later list does not reopen the page).
  const installedReading = useInstalledApps(host.key);
  const apps = installedReading.state === 'value' ? installedReading.value : null;
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const known = apps !== null;
  const extensionId = page?.extensionId;
  const settled = page?.page === 'manage' || (page?.page === 'market' && !!extensionId && hasSubject(extensionId));
  useEffect(() => {
    const installedApps = appsRef.current;
    if (!page || !ready || settled || !installedApps) return;
    let cancelled = false;
    const open = async () => {
      if (deviceId) {
        const local = readCachedDevices().some((row) => row.device_id === deviceId && row.is_current_device);
        if (host.key !== (local ? 'local' : `remote:${deviceId}`)) throw new Error('The App link names another device; reopen the link or reconnect that device.');
      }
      const installed = page.page ? undefined : installedApps.manifests.find((row) => row.id === page.extensionId);
      if (page.variant && !installed) throw new Error('The installed App is no longer available on this device.');
      if (installed) {
        onPage('manage');
        // The same App's page may already be showing, scrolled down: asking for it again starts at the top.
        rootRef.current?.scrollIntoView({ block: 'start' });
        return;
      }
      const entry = await marketEntry.fetch(host.key, page.extensionId);
      if (cancelled) return;
      if (!entry) throw new Error('This App is no longer in the market.');
      onSubject({ manifest: entry.manifest, cloud: entry.cloud, installRef: entry.ref });
      if (!page.page) onPage('market');
    };
    void open().catch((error: unknown) => { if (!cancelled) toast({ title: messageForUser(error), variant: 'destructive' }); });
    return () => { cancelled = true; };
    // A new page (another App, or a link settled) is a new request; the callbacks are the card's, fresh each render.
  }, [extensionId, page?.page, settled, ready, known, host, deviceId]);
  const variants = extensionId && apps ? apps.variants[extensionId] : undefined;
  useEffect(() => {
    if (page?.variant && page.page === 'manage') {
      rootRef.current?.querySelector(`[data-testid="app-variant-${page.variant}"]`)?.scrollIntoView({ block: 'center' });
    }
  }, [page?.variant, page?.page, variants, rootRef]);
}
