import { Plus } from '@/lib/icons';
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary';
import { OwnerConnectorsSettings } from '@/components/connections/OwnerConnectorsSettings';
import { useDevicesStore } from '@/store/devicesContext';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import { useAddMcpServer } from '@renderer/features/mcp/components/use-add-mcp-server';
import { useMcpLibrary } from '@renderer/features/mcp/components/use-mcp-library';
import IntegrationsCard from '@renderer/features/settings/components/IntegrationsCard';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { observer } from 'mobx-react-lite';

export const ConnectorMarketPage = observer(function ConnectorMarketPage({ query }: { query: string }) {
  const devices = useDevicesStore();
  const deviceId = devices.devices.find((row) => row.is_current_device)?.device_id ?? null;
  return (
    <div className="pb-14" data-testid="connector-market-panel">
      <ConnectionRouteBoundary
        owner={(route) => <OwnerConnectorsSettings route={route} deviceId={deviceId} marketQuery={query} />}
        legacy={<IntegrationsProvider><IntegrationsCard marketQuery={query} /></IntegrationsProvider>}
      />
    </div>
  );
});

export function AddConnectorButton() {
  const { translate } = useSessionMessages();
  const library = useMcpLibrary();
  const open = useAddMcpServer(library);
  return (
    <Button size="sm" disabled={library.isLoading || library.isBusy || !library.hasData} onClick={() => void open()}>
      <Plus className="size-4" aria-hidden />
      {translate('extensions.addConnector')}
    </Button>
  );
}
