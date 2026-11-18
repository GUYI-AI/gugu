import { observer } from 'mobx-react-lite';
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary';
import { OwnerConnectorsSettings } from '@/components/connections/OwnerConnectorsSettings';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useDevicesStore } from '@/store/devicesContext';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import IntegrationsCard from '@renderer/features/settings/components/IntegrationsCard';
import { PageHeader } from '@renderer/lib/components/page-header';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { LibraryHost } from './library-host';

function LegacyIntegrations({ inSettings }: { inSettings: boolean }) {
  const { translate } = useSessionMessages();
  return (
    <div className={inSettings ? 'space-y-2' : 'space-y-8'}>
      {inSettings ? (
        <SectionLabel>{translate('integrations.accountsLabel')}</SectionLabel>
      ) : (
        <PageHeader sticky title={translate('settings.integrations')} />
      )}
      <IntegrationsCard inSettings={inSettings} />
    </div>
  );
}

export const RoutedIntegrationsLibraryPage = observer(function RoutedIntegrationsLibraryPage({ host, inSettings = false }: {
  host: LibraryHost;
  inSettings?: boolean;
}) {
  const devices = useDevicesStore();
  const deviceId = host.remote?.deviceId ?? devices.devices.find(row => row.is_current_device)?.device_id ?? null;
  const legacy = <LegacyIntegrations inSettings={inSettings} />;
  return (
    <ConnectionRouteBoundary
      owner={route => <OwnerConnectorsSettings route={route} deviceId={deviceId} />}
      legacy={host.remote || inSettings ? <IntegrationsProvider>{legacy}</IntegrationsProvider> : legacy}
    />
  );
});
