import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { log } from '@renderer/utils/logger';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { TOO_OLD_CODES } from '@renderer/features/remote-hosts/connection-status';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { marketCompatText, type MarketListItem } from '@shared/extensions/market';
import { remoteHostReachable, type RemoteHostDevice } from '@shared/remote-hosts';
import { MarketDetailDeviceRow, MarketDetailDevices } from './market-detail-devices';
import { commitMarketInstall, prepareMarketInstall, useConfirmMarketInstall } from './market-detail-install';

export function MarketExtensionDevices({ item }: { item: MarketListItem }) {
  return (
    <MarketDetailDevices>
      {(device, waking) => <OtherDevice item={item} device={device} waking={waking} />}
    </MarketDetailDevices>
  );
}

function OtherDevice({ item, device, waking }: { item: MarketListItem; device: RemoteHostDevice; waking: boolean }) {
  const { translate } = useSessionMessages();
  const { api, store } = useLibraryHost().extensions;
  const client = useQueryClient();
  const extensionId = item.manifest.id;
  const queryKey = ['market-extension-device', device.id, extensionId, item.cloud.version] as const;
  const mutationKey = ['market-extension-install', device.id, extensionId] as const;
  const online = remoteHostReachable(device);
  const status = useQuery({
    queryKey,
    enabled: online,
    retry: false,
    queryFn: async () => {
      const [inventory, catalog] = await Promise.all([api.list(), api.marketEntry({ extensionId })]);
      if (!inventory.success || !inventory.data) throw new Error(inventory.error);
      if (!catalog.success) throw new Error(catalog.error);
      const installed = inventory.data.extensions.find((entry) => entry.id === extensionId);
      const offered = catalog.data ?? null;
      const preinstalled = inventory.data.origins?.[extensionId] === 'preinstalled';
      const missedVersion = offered?.cloud.newerNeedsApp;
      const needsVersion = offered && missedVersion && compareExtensionVersions(missedVersion, offered.cloud.version) > 0
        && (!installed || compareExtensionVersions(missedVersion, installed.version) > 0);
      const versions = needsVersion ? await api.marketHistory({ extensionId }) : null;
      const blockedRelease = versions?.data?.find((entry) => entry.version === missedVersion);
      return { installed, offered, preinstalled, blockedRelease, missedVersion: needsVersion ? missedVersion : null };
    },
  });
  const offered = status.data?.offered;
  const installed = status.data?.installed;
  const confirm = useConfirmMarketInstall(offered?.cloud.version ?? item.cloud.version, device.label);
  const busy = useIsMutating({ mutationKey, exact: true }) > 0;
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: async (target: MarketListItem) => {
      const { ask, asks } = await prepareMarketInstall(api, target.ref);
      if (!await confirm(ask, asks)) return false;
      const result = await commitMarketInstall(api, ask);
      if (!result.success) throw new Error(result.error);
      return true;
    },
    onSuccess: (installed) => {
      if (!installed) return;
      void client.invalidateQueries({ queryKey: ['market-extension-device', device.id, extensionId] });
      // Installed owns and caches its own per-device inventory.
      void store.load().catch(() => undefined);
      void store.checkUpdates();
      toast({ title: translate('extensions.bundleCardInstalledOn', { machine: device.label }), tier: 'success' });
    },
    onError: (error) => {
      log.error('extension market install on another computer failed:', { deviceId: device.id, error });
      toast({ title: translate('extensions.installFailedOn', { machine: device.label }), tier: 'error' });
    },
  });
  const start = (target: MarketListItem) => {
    if (!client.isMutating({ mutationKey, exact: true })) mutate(target);
  };

  const { blockedRelease, missedVersion } = status.data ?? {};
  const incompat = online ? (
    blockedRelease?.compat ? marketCompatText(blockedRelease.compat, translate)
      : blockedRelease?.platformRefusal ? translate('extensions.platformVersionUnavailable')
      : missedVersion ? translate('extensions.newerNeedsApp', { version: missedVersion })
      : offered?.cloud.compat ? marketCompatText(offered.cloud.compat, translate)
      : null
  ) : null;
  const outOfDate = status.error && TOO_OLD_CODES.has((status.error as { code?: string }).code ?? '');
  const canInstall = online && !status.isError && !status.data?.preinstalled && !incompat && offered
    && (!installed || compareExtensionVersions(offered.cloud.version, installed.version) > 0);
  const version = installed ? `v${installed.version}` : null;
  const installStatus = incompat
    ?? (status.isError ? translate(outOfDate ? 'extensions.tileNeedsApp' : 'marketDetail.deviceUnavailable')
      : version
        ? `${version}${!canInstall && online ? ` · ${translate('marketDetail.deviceInstalled')}` : ''}`
        : status.data ? translate('marketDetail.deviceNotInstalled') : online ? translate('extensions.loading') : undefined);
  const action = waking || busy || canInstall ? (
    <Button
      size="sm"
      variant="outline"
      disabled={!canInstall || busy}
      aria-busy={busy || undefined}
      onClick={offered ? () => start(offered) : undefined}
    >
      {busy && <Spinner size="sm" />}
      {busy ? translate(installed ? 'marketDetail.updating' : 'extensions.installing')
        : installed && offered ? translate('extensions.updateTo', { version: offered.cloud.version })
        : translate('extensions.installAction')}
    </Button>
  ) : undefined;

  return <MarketDetailDeviceRow device={device} waking={waking} status={installStatus} action={online || waking ? action : undefined} />;
}
