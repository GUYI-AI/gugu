import { observer } from 'mobx-react-lite';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { refreshTag } from '@/lib/replica';
import { INSTALLED } from '../extensions-api';
import { installedExtensions } from '../installed-extensions';
import { marketEntry, marketVersionHistory } from '../market-replicas';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { marketCompatText, type MarketListItem } from '@shared/extensions/market';
import { MarketDevicePicker, useMarketDevicePicker } from './market-detail-devices';
import { useConfirmMarketInstall } from './market-detail-install';
import { commitMarketInstall, prepareMarketInstall } from './market-extension-install-rpc';

/** What a device has and is offered, through that host's installed list, market entry and version history. */
async function readApplicationOnDevice(hostKey: string, extensionId: string) {
  const [inventory, offered] = await Promise.all([installedExtensions.fetch(hostKey), marketEntry.fetch(hostKey, extensionId)]);
  const installed = inventory.extensions.find((entry) => entry.id === extensionId);
  const preinstalled = inventory.origins?.[extensionId] === 'preinstalled';
  const missedVersion = offered?.cloud.newerNeedsApp;
  const blockedByVersion = missedVersion && (!installed || compareExtensionVersions(missedVersion, installed.version) > 0);
  const versions = blockedByVersion ? await marketVersionHistory.fetch(hostKey, extensionId).catch(() => null) : null;
  const blockedRelease = versions?.find((entry) => entry.version === missedVersion);
  return { installed, preinstalled, offered, missedVersion: blockedByVersion ? missedVersion : null, blockedRelease };
}

export const MarketExtensionDevices = observer(function MarketExtensionDevices({ item }: { item: MarketListItem }) {
  const { translate } = useSessionMessages();
  const confirm = useConfirmMarketInstall(item.cloud.version);
  const id = item.manifest.id;
  const picker = useMarketDevicePicker({
    itemKey: `application:${id}`,
    read: ({ host }) => readApplicationOnDevice(host.extensions.key, id),
    describe: ({ installed, preinstalled, offered, missedVersion, blockedRelease }) => {
      const compat = blockedRelease?.compat ?? offered?.cloud.compat;
      if (!preinstalled && (compat || blockedRelease?.platformRefusal || missedVersion)) {
        return {
          state: 'blocked', detail: translate('marketDetail.deviceIncompatible'),
          hint: compat ? marketCompatText(compat, translate)
            : blockedRelease?.platformRefusal ? translate('extensions.platformVersionUnavailable')
            : translate('extensions.newerNeedsApp', { version: missedVersion ?? '' }),
        };
      }
      if (installed && (preinstalled || !offered || compareExtensionVersions(offered.cloud.version, installed.version) <= 0)) {
        return { state: 'current', detail: translate('marketDetail.deviceInstalled'), hint: `v${installed.version}` };
      }
      if (!offered) return { state: 'blocked', detail: translate('marketDetail.deviceUnavailable') };
      return {
        state: 'available',
        detail: installed ? translate('marketDetail.deviceUpdate') : '',
        hint: installed ? `v${installed.version}` : undefined,
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
    refresh: ({ host }) => refreshTag(INSTALLED, host.extensions.key),
  });
  return <MarketDevicePicker {...picker} />;
});
