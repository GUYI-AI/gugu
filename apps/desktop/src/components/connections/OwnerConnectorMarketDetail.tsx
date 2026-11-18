import type { AssistantConnectedApp } from '@/components/assistant/assistant-app-connections';
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon';
import { WechatAppConnection } from '@/components/settings/channels/WechatAppConnection';
import { useOwnerConnectionStore } from '@/lib/connectionBridge';
import { useDevicesStore } from '@/store/devicesContext';
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { keptByPlatform } from '@renderer/features/integrations/integration-setup-model';
import { useIntegrationsContext } from '@renderer/features/integrations/integrations-provider';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { MarketConnectorAuthorization, MarketConnectorDetail, type ConnectorTarget } from '@renderer/features/extensions/panel/market-detail-connector';
import type { LibraryHost } from '@renderer/features/library/library-host';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useOwnerLibraryHost } from './useOwnerLibraryHost';

export function OwnerConnectorMarketDetail({ app, host, route, deviceId, readOnly, onClose }: {
  app: AssistantConnectedApp;
  host: LibraryHost;
  route?: ConnectionRoute;
  deviceId: string | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const data = useIntegrationsContext();
  const metadata = app.integration;
  const platform = keptByPlatform(metadata);
  const ownerConnections = useOwnerConnectionStore(null, route, route?.mode === 'owner' && !platform);
  const readDevice = ownerConnections && metadata ? async ({ deviceId }: ConnectorTarget) => {
    const rows = await ownerConnections.collection('integrations');
    return rows.some((item) => item.data.providerId === app.id && typeof item.data.accountId === 'string'
      && (item.source?.scopeKey === 'platform' || item.device_id === deviceId));
  } : undefined;
  const authorize = (target: ConnectorTarget, done: (ok: boolean) => void) => {
    if (!metadata) return (
      <>
        <DialogHeader><DialogTitle>{app.name}</DialogTitle></DialogHeader>
        <div className="px-6 pb-6"><WechatAppConnection /></div>
      </>
    );
    return target.deviceId === deviceId
      ? <MarketConnectorAuthorization host={host} id={app.id} done={done} key={host.key} />
      : <OwnerRemoteAuthorization deviceId={target.deviceId} id={app.id} route={route} done={done} key={target.deviceId} />;
  };

  return <MarketConnectorDetail
    id={app.id}
    name={app.name}
    description={app.description}
    icon={metadata ? <IntegrationIcon provider={app.id} icon={metadata.icon} size={68} /> : <ChannelBrandIcon kind="wechat" size={68} />}
    abilities={metadata?.abilities ?? []}
    playbooks={metadata?.playbooks ?? []}
    connected={app.state === 'connected'}
    status={app.connectionStatus}
    readOnly={readOnly}
    local={{ host, deviceId }}
    readDevice={readDevice}
    authorize={authorize}
    onConnected={() => { ownerConnections?.invalidate(); data.reloadConnections(); }}
    onDisconnect={app.saved && metadata ? async () => { await data.disconnectIntegration(app.id); } : undefined}
    disconnectDescription={platform ? translate('integrations.platformDisconnectNotice', { name: app.name, credential: metadata?.disconnectCredentialLabel ?? app.name }) : undefined}
    onTryPlaybook={metadata?.playbooks?.length ? (prompt) => {
      composerDrafts.set(NEW_SESSION_DRAFT_KEY, prompt);
      navigate('new-session');
    } : undefined}
    onClose={onClose}
  />;
}

function OwnerRemoteAuthorization({ deviceId, id, route, done }: {
  deviceId: string | null;
  id: string;
  route?: ConnectionRoute;
  done: (ok: boolean) => void;
}) {
  const devices = useDevicesStore();
  const device = devices.devices.find((row) => row.device_id === deviceId) ?? null;
  const host = useOwnerLibraryHost(device, route);
  return <MarketConnectorAuthorization host={host} id={id} done={done} />;
}
