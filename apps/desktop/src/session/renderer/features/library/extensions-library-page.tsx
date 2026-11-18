import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { ExtensionsSettingsCard, type MarketplaceTab } from '@renderer/features/settings/components/ExtensionsSettingsCard';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost } from './library-host';

/** Marketplace and direct links to an application on a named device. */
export function ExtensionsLibraryPage({ detail, onOpenAgentDetail, marketPage, onMarketPageChange, onCloseDetailLink }: {
  detail?: ExtensionAppDetailLink;
  onCloseDetailLink?: () => void;
  marketPage?: MarketplaceTab;
  onMarketPageChange?: (page: MarketplaceTab) => void;
  onOpenAgentDetail?: (agentId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const { remote } = useLibraryHost();
  // 页头(名字、一句话、搜索)由那张卡片自己画:点进一个 App 的产品页时整栏换成那一页,页头跟着让开(#7059)。
  if (remote?.hostKind !== 'server') return <ExtensionsSettingsCard detailLink={detail} onCloseDetailLink={onCloseDetailLink} onOpenAgentDetail={onOpenAgentDetail} marketPage={marketPage} onMarketPageChange={onMarketPageChange} />;
  return (
    <div className="space-y-3">
      <p className="m-0 px-3 pt-3 text-sm text-foreground-muted" data-testid="extensions-on-server">
        {translate('deviceScope.extensionsOnServer', { device: remote.deviceLabel })}
      </p>
      <ExtensionsSettingsCard detailLink={detail} onCloseDetailLink={onCloseDetailLink} onOpenAgentDetail={onOpenAgentDetail} marketPage={marketPage} onMarketPageChange={onMarketPageChange} />
    </div>
  );
}
