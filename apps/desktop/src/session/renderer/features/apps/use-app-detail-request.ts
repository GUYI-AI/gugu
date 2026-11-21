import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { readCachedDevices } from '@/store/devicesCache';
import { messageForUser } from '@/lib/userFacingError';
import type { ExtensionsHost } from '@renderer/features/extensions/extensions-host';
import { useInstalledApps } from '@renderer/features/extensions/installed-extensions';
import { marketEntry } from '@renderer/features/extensions/market-replicas';
import type { AppDetail } from '@renderer/features/settings/components/ExtensionsSettingsCard';
import { toast } from '@renderer/lib/hooks/use-toast';

/**
 * Navigation opens a detail once: an installed App's settings page, or the market's page of one that is not here.
 * Background market refreshes do not reopen a page the person left.
 */
export function useAppDetailRequest({ target, ready, host, setDetail, detail, rootRef }: {
  target?: ExtensionAppDetailLink; ready: boolean; host: ExtensionsHost;
  setDetail: Dispatch<SetStateAction<AppDetail | null>>; detail: AppDetail | null;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  // What is installed on that host, read when the request is taken (a later list does not reopen the page).
  const installedReading = useInstalledApps(host.key);
  const apps = installedReading.state === 'value' ? installedReading.value : null;
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const known = apps !== null;
  useEffect(() => {
    const installedApps = appsRef.current;
    if (!target || !ready || !installedApps) return;
    let cancelled = false;
    const open = async () => {
      if (target.deviceId) {
        const local = readCachedDevices().some((row) => row.device_id === target.deviceId && row.is_current_device);
        if (host.key !== (local ? 'local' : `remote:${target.deviceId}`)) throw new Error('The App link names another device; reopen the link or reconnect that device.');
      }
      const installed = installedApps.manifests.find((row) => row.id === target.extensionId);
      if (target.variant && !installed) throw new Error('The installed App is no longer available on this device.');
      if (installed) {
        setDetail({ page: 'manage', extensionId: target.extensionId, fromApp: target.fromApp });
        // The same App's page may already be showing, scrolled down: asking for it again starts at the top.
        rootRef.current?.scrollIntoView({ block: 'start' });
        return;
      }
      const entry = await marketEntry.fetch(host.key, target.extensionId);
      if (cancelled) return;
      if (!entry) throw new Error('This App is no longer in the market.');
      setDetail({ page: 'market', subject: { manifest: entry.manifest, cloud: entry.cloud, installRef: entry.ref } });
    };
    void open().catch((error: unknown) => { if (!cancelled) toast({ title: messageForUser(error), variant: 'destructive' }); });
    return () => { cancelled = true; };
  }, [target, ready, known, host, setDetail, rootRef]);
  const variants = target && apps ? apps.variants[target.extensionId] : undefined;
  useEffect(() => {
    if (target?.variant && detail?.page === 'manage' && detail.extensionId === target.extensionId) {
      rootRef.current?.querySelector(`[data-testid="app-variant-${target.variant}"]`)?.scrollIntoView({ block: 'center' });
    }
  }, [target, detail, variants, rootRef]);
}
