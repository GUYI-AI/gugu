import { observer } from 'mobx-react-lite';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { LibraryHost } from '@renderer/features/library/library-host';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { marketCompatText, type MarketListItem } from '@shared/extensions/market';
import { MarketDevicePicker, useMarketDevicePicker } from './market-detail-devices';
import { commitMarketInstall, prepareMarketInstall, useConfirmMarketInstall } from './market-detail-install';

async function readApplicationOnDevice(api: LibraryHost['extensions']['api'], extensionId: string) {
  const [inventory, catalog] = await Promise.all([api.list(), api.marketEntry({ extensionId })]);
  if (!inventory.success || !inventory.data) throw new Error(inventory.error);
  if (!catalog.success) throw new Error(catalog.error);
  const installed = inventory.data.extensions.find((entry) => entry.id === extensionId);
  const preinstalled = inventory.data.origins?.[extensionId] === 'preinstalled';
  const offered = catalog.data ?? null;
  const missedVersion = offered?.cloud.newerNeedsApp;
  const blockedByVersion = missedVersion && (!installed || compareExtensionVersions(missedVersion, installed.version) > 0);
  const versions = blockedByVersion ? await api.marketHistory({ extensionId }).catch(() => null) : null;
  const blockedRelease = versions?.data?.find((entry) => entry.version === missedVersion);
  return { installed, preinstalled, offered, missedVersion: blockedByVersion ? missedVersion : null, blockedRelease };
}

export const MarketExtensionDevices = observer(function MarketExtensionDevices({ item }: { item: MarketListItem }) {
  const { translate } = useSessionMessages();
  const confirm = useConfirmMarketInstall(item.cloud.version);
  const id = item.manifest.id;
  const picker = useMarketDevicePicker({
    itemKey: `application:${id}`,
    read: ({ host }) => readApplicationOnDevice(host.extensions.api, id),
    describe: ({ installed, preinstalled, offered, missedVersion, blockedRelease }) => {
      const compat = blockedRelease?.compat ?? offered?.cloud.compat;
      if (!preinstalled && (compat || blockedRelease?.platformRefusal || missedVersion)) {
        return {
          state: 'blocked', detail: compat ? marketCompatText(compat, translate)
            : blockedRelease?.platformRefusal ? translate('extensions.platformVersionUnavailable')
            : translate('extensions.newerNeedsApp', { version: missedVersion ?? '' }),
        };
      }
      if (installed && (preinstalled || !offered || compareExtensionVersions(offered.cloud.version, installed.version) <= 0)) {
        return { state: 'current', detail: `v${installed.version} · ${translate('marketDetail.deviceInstalled')}` };
      }
      if (!offered) return { state: 'blocked', detail: translate('marketDetail.deviceUnavailable') };
      return {
        state: 'available',
        detail: installed ? translate('marketDetail.deviceUpdate', { version: installed.version }) : translate('marketDetail.deviceNotInstalled'),
        plan: offered,
      };
    },
    install: async ({ host, device }, candidate: MarketListItem) => {
      const { api } = host.extensions;
      const { ask, asks } = await prepareMarketInstall(api, candidate.ref);
      if (!await confirm(ask, asks, { machine: device.label, offeredVersion: candidate.cloud.version })) return false;
      const result = await commitMarketInstall(api, ask);
      if (!result.success) throw new Error(result.error);
      return true;
    },
    refresh: async ({ host }) => {
      await host.extensions.store.load();
      await host.extensions.store.checkUpdates();
    },
  });
  return <MarketDevicePicker {...picker} />;
});
