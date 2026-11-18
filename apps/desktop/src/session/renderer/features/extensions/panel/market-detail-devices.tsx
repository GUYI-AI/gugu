import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { Monitor } from '@/lib/icons';
import type { RemoteHostDevice } from '@shared/remote-hosts';
import { remoteHostReachable } from '@shared/remote-hosts';
import { formatAgo } from '@renderer/features/remote-hosts/connection-status';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

export const MarketDetailDevices = observer(function MarketDetailDevices({ children }: {
  children: (device: RemoteHostDevice, waking: boolean) => ReactNode;
}) {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const devices = [...remoteHostsStore.hosts.values()]
    .map(({ device }) => device)
    .filter((device) => !device.isCurrentMachine && !device.assistantHome)
    .sort((a, b) => Number(remoteHostReachable(b)) - Number(remoteHostReachable(a)) || a.label.localeCompare(b.label));
  return (
    <section aria-label={translate('marketDetail.otherDevices')} className="rounded-2xl border border-border p-2">
      <h3 className="px-2 py-1 text-xs text-foreground-muted">{translate('marketDetail.otherDevices')}</h3>
      {devices.length ? (
        <ul className="divide-y divide-border">
          {devices.map((device) => {
            const waking = remoteHostsStore.cloudScope(device.id)?.state === 'waking' && !remoteHostReachable(device);
            const host = machineLibraryHost({
              deviceId: device.id, deviceLabel: device.label, online: remoteHostReachable(device),
              hostKind: device.hostKind, lastSeenAt: device.lastSeenAt,
            });
            return <LibraryHostProvider value={host} key={device.id}>{children(device, waking)}</LibraryHostProvider>;
          })}
        </ul>
      ) : <p className="px-2 py-2 text-foreground-muted">{translate('marketDetail.noOtherDevices')}</p>}
    </section>
  );
});

export function MarketDetailDeviceRow({ device, waking, status, action }: {
  device: RemoteHostDevice;
  waking: boolean;
  status?: ReactNode;
  action?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const online = remoteHostReachable(device);
  const ago = !online && !waking ? formatAgo(device.lastSeenAt, Date.now(), translate) : null;
  return (
    <li className={cn('flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-2', !online && 'text-foreground-muted')} data-device-id={device.id}>
      <Monitor className="size-4 shrink-0" aria-hidden />
      <span className="font-medium">{device.label}</span>
      {!waking && (
        <span className="text-xs text-foreground-muted">{translate(online ? 'marketDetail.online' : 'marketDetail.offline')}</span>
      )}
      <span className="ml-auto text-right text-xs text-foreground-muted">
        {waking ? translate('marketDetail.waking') : ago ? translate('marketDetail.lastSeen', { ago }) : status}
      </span>
      {action}
    </li>
  );
}
