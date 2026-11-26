import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { Check, Ellipsis, FileText } from '@/lib/icons';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@renderer/lib/ui/button';
import { toast } from '@renderer/lib/hooks/use-toast';
import { log } from '@renderer/utils/logger';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { IntegrationSetupModal } from '@renderer/features/integrations/integration-setup-modal';
import { GithubConnectModal } from '@renderer/features/settings/components/github-connect-modal';
import { GithubDeviceFlowModal } from '@renderer/lib/components/github-device-flow-modal';
import type { LibraryHost } from '@renderer/features/library/library-host';
import { MarketDetailCard, MarketDetailDialog, useMarketDetailConfirmation, useMarketDetailQueue } from './market-detail-dialog';
import { MarketDevicePicker, useMarketDevicePicker } from './market-detail-devices';

export type ConnectorTarget = { deviceId: string | null; host: LibraryHost };

type MarketConnectorProps = {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  connected: boolean;
  readOnly?: boolean;
  status?: string;
  abilities: readonly string[];
  playbooks: readonly { title: string; prompt: string }[];
  local: ConnectorTarget;
  readDevice?: (target: ConnectorTarget) => Promise<boolean>;
  authorizationOwnDialog?: boolean;
  authorize?: (target: ConnectorTarget, done: (ok: boolean) => void) => ReactNode;
  onConnected?: () => void;
  onDisconnect?: () => void | Promise<void>;
  disconnectDescription?: string;
  onTryPlaybook?: (prompt: string) => void;
  onClose: () => void;
};

export function MarketConnectorDetail(props: MarketConnectorProps) {
  return (
    <MarketDetailDialog onClose={props.onClose}>
      <MarketConnectorCard {...props} />
    </MarketDetailDialog>
  );
}

function MarketConnectorCard({
  id, name, description, icon, connected, readOnly, status, abilities, playbooks,
  local, readDevice, authorizationOwnDialog, authorize, onConnected, onDisconnect, disconnectDescription, onTryPlaybook, onClose,
}: MarketConnectorProps) {
  const { translate } = useSessionMessages();
  const confirm = useMarketDetailConfirmation();
  const { active, enqueue, finish } = useMarketDetailQueue<ConnectorTarget>();
  const connect = () => void enqueue(local);
  const authorization = active?.value;
  const disconnect = async () => {
    if (!onDisconnect || !await confirm({
      title: translate('integrations.disconnectConfirmTitle', { name }),
      description: disconnectDescription ?? translate('integrations.disconnectLoseAccess', { name }),
      confirmLabel: translate('integrations.disconnect'),
      variant: 'destructive',
    })) return;
    try {
      await onDisconnect();
    } catch (error) {
      log.error('Marketplace connector disconnect failed:', { id, error });
      toast({ title: translate('marketDetail.disconnectFailed', { name }), tier: 'error' });
    }
  };
  const finishConnect = (ok: boolean) => {
    finish(ok);
    if (ok) onConnected?.();
  };

  return (
    <>
      <MarketDetailCard
        name={name}
        icon={icon}
        subtitle={description}
        notice={status ? <p role="status" className="text-foreground-muted">{status}</p> : undefined}
        actions={(
          <>
            <Button disabled={connected || readOnly} onClick={connect}>
              {translate(connected ? 'integrations.statusConnected' : 'integrations.connect')}
            </Button>
            {connected && !readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={translate('common.more')} />}>
                  <Ellipsis aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={connect}>{translate('integrations.reconnect')}</DropdownMenuItem>
                  {onDisconnect && (
                    <DropdownMenuItem onClick={() => void disconnect()} variant="destructive">{translate('integrations.disconnect')}</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
        devices={readDevice && !readOnly ? (
          <MarketConnectorDevices id={id} readDevice={readDevice} connect={enqueue} authorizing={!!authorization} />
        ) : undefined}
      >
        {abilities.length > 0 && (
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
              <Check className="size-4 text-foreground-muted" aria-hidden />{translate('integrations.abilitiesLabel')}
            </h3>
            <ul className="space-y-2 rounded-2xl border border-border p-4 text-foreground-muted">
              {abilities.map((ability) => <li key={ability} className="flex items-start gap-2">
                <Check className="mt-1 size-3 shrink-0" aria-hidden />{ability}
              </li>)}
            </ul>
          </section>
        )}
        {playbooks.length > 0 && (
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
              <FileText className="size-4 text-foreground-muted" aria-hidden />{translate('integrations.playbooksLabel')}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {playbooks.map(({ title, prompt }) => (
                <div key={title} className="flex flex-col items-start gap-2 rounded-2xl border border-border p-4">
                  <p className="font-medium">{title}</p>
                  <p className="flex-1 text-foreground-muted">{prompt}</p>
                  {onTryPlaybook && (
                    <Button variant="outline" size="sm" onClick={() => { onClose(); onTryPlaybook(prompt); }}>
                      {translate('integrations.tryOut')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </MarketDetailCard>
      {authorization && authorizationOwnDialog && authorize?.(authorization, finishConnect)}
      {authorization && !authorizationOwnDialog && (
        <Dialog open onOpenChange={(open) => { if (!open) finishConnect(false); }}>
          <DialogContent className="rounded-2xl bg-background sm:max-w-[480px]">
            {authorize
              ? authorize(authorization, finishConnect)
              : <MarketConnectorAuthorization id={id} host={authorization.host} done={finishConnect} key={authorization.host.key} />}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function MarketConnectorAuthorization({ id, host, done }: { id: string; host: LibraryHost; done: (ok: boolean) => void }) {
  const [deviceFlow, setDeviceFlow] = useState(false);
  const onSuccess = () => done(true);
  const onClose = () => done(false);
  if (id !== 'github') return <IntegrationSetupModal integration={id} host={host} onSuccess={onSuccess} onClose={onClose} />;
  return deviceFlow
    ? <GithubDeviceFlowModal host={host} onSuccess={onSuccess} onClose={onClose} />
    : <GithubConnectModal host={host} onSuccess={onSuccess} onClose={onClose} onDeviceFlow={() => setDeviceFlow(true)} />;
}

const MarketConnectorDevices = observer(function MarketConnectorDevices({ id, readDevice, connect, authorizing }: {
  id: string;
  readDevice: (target: ConnectorTarget) => Promise<boolean>;
  connect: (target: ConnectorTarget) => Promise<boolean>;
  authorizing: boolean;
}) {
  const { translate } = useSessionMessages();
  const picker = useMarketDevicePicker({
    itemKey: `connector:${id}`,
    read: ({ device, host }) => readDevice({ deviceId: device.id, host }),
    describe: (connected) => connected
      ? { state: 'current', detail: translate('integrations.statusConnected') }
      : { state: 'available', detail: '', plan: true },
    install: ({ device, host }) => connect({ deviceId: device.id, host }),
  });
  return <MarketDevicePicker {...picker} blockDismiss={authorizing} submitLabel={translate('integrations.connect')} />;
});
