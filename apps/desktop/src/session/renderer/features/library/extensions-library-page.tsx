import type { ReactNode } from 'react';
import { ExtensionsSettingsCard } from '@renderer/features/settings/components/ExtensionsSettingsCard';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost } from './library-host';

/** Marketplace and direct links to an application on a named device. */
export function ExtensionsLibraryPage({ onOpenAgentDetail, installedPage }: {
  onOpenAgentDetail?: (agentId: string) => void;
  installedPage?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const { remote } = useLibraryHost();
  // 页头(名字、一句话、搜索)由那张卡片自己画:点进一个 App 的产品页时整栏换成那一页,页头跟着让开(#7059)。
  if (remote?.hostKind !== 'server') return <ExtensionsSettingsCard onOpenAgentDetail={onOpenAgentDetail} installedPage={installedPage} />;
  return (
    <div className="space-y-3">
      <p className="m-0 px-3 pt-3 text-sm text-foreground-muted" data-testid="extensions-on-server">
        {translate('deviceScope.extensionsOnServer', { device: remote.deviceLabel })}
      </p>
      <ExtensionsSettingsCard onOpenAgentDetail={onOpenAgentDetail} installedPage={installedPage} />
    </div>
  );
}
