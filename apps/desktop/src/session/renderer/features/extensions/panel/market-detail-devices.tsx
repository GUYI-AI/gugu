import { useMutation, useMutationState } from '@tanstack/react-query';
import { useReplicas, type Reading as ReplicaReading } from '@/lib/replica';
import { marketDeviceReading, readOnDevicesWith } from '../market-device-readings';
import { useEffect, useState } from 'react';
import { ChevronDown } from '@/lib/icons';
import type { RemoteHostDevice } from '@shared/remote-hosts';
import { remoteHostReachable } from '@shared/remote-hosts';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { toast } from '@renderer/lib/hooks/use-toast';
import { formatAgo, TOO_OLD_CODES } from '@renderer/features/remote-hosts/connection-status';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { useMarketDetailConfirming } from './market-detail-dialog';

type DeviceState<Plan> = { detail: string; hint?: string } & (
  | { state: 'available'; plan: Plan }
  | { state: 'current' | 'blocked' }
);

type PickerRow = {
  id: string;
  name: string;
  detail: string;
  hint?: string;
  state: DeviceState<unknown>['state'] | 'reading' | 'working';
  start?: () => void;
};

type Target = { device: RemoteHostDevice; host: LibraryHost };

export function useMarketDevicePicker<Reading, Plan>({
  itemKey, read, describe, install, refresh,
}: {
  itemKey: string;
  read: (target: Target) => Promise<Reading>;
  describe: (reading: Reading) => DeviceState<Plan>;
  install: (target: Target, plan: Plan) => Promise<boolean>;
  refresh?: (target: Target) => Promise<unknown>;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const devices = opened
    ? [...remoteHostsStore.hosts.values()]
      .map(({ device }) => device)
      .filter((device) => !device.isCurrentMachine && !device.assistantHome)
      .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  useEffect(() => remoteHostsStore.start(), []);
  const targets = devices.map((device) => {
    const host = machineLibraryHost({
      deviceId: device.id, deviceLabel: device.label, online: remoteHostReachable(device),
      hostKind: device.hostKind, lastSeenAt: device.lastSeenAt,
    });
    return { device, host };
  });
  const readKey = `desktop:${itemKey}`;
  readOnDevicesWith(readKey, (deviceId) => {
    const target = targets.find(({ device }) => device.id === deviceId);
    if (!target) throw new Error(`No device ${deviceId}`);
    return read(target);
  });
  // A device that cannot be reached is not asked (nothing would answer): its row says so instead.
  const asked = targets.filter(({ device }) => remoteHostReachable(device));
  const readings = useReplicas(marketDeviceReading, asked.map(({ device }) => [readKey, device.id] as [string, string]));
  const readingOf = (deviceId: string) => readings[asked.findIndex(({ device }) => device.id === deviceId)] as ReplicaReading<Reading>;
  const mutationKey = ['market-device-install', itemKey] as const;
  type Operation = { target: Target; plan: Plan };
  const running = useMutationState<string | undefined>({
    filters: { mutationKey, exact: true, status: 'pending' },
    select: (entry) => (entry.state.variables as Operation | undefined)?.target.device.id,
  });
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: ({ target, plan }: Operation) => install(target, plan),
    onSuccess: async (ok, { target }) => {
      if (!ok) return;
      await marketDeviceReading.refresh(readKey, target.device.id);
      void refresh?.(target).catch((error: unknown) => log.warn('Marketplace device inventory refresh failed:', error));
    },
    onError: (error, { target }) => {
      log.error('Marketplace install on another computer failed:', { deviceId: target.device.id, error });
      toast({ title: translate('extensions.installFailedOn', { machine: target.device.label }), tier: 'error' });
    },
  });

  const rows: PickerRow[] = targets.map((target) => {
    const { device } = target;
    const row = { id: device.id, name: device.label };
    if (running.includes(device.id)) return { ...row, state: 'working', detail: translate('extensions.installing') };
    if (!remoteHostReachable(device)) {
      const waking = remoteHostsStore.cloudScope(device.id)?.state === 'waking';
      const ago = formatAgo(device.lastSeenAt, Date.now(), translate);
      return {
        ...row,
        state: 'blocked',
        detail: translate(waking ? 'marketDetail.waking' : 'marketDetail.offline'),
        hint: !waking && ago ? translate('marketDetail.lastSeen', { ago }) : undefined,
      };
    }
    const reading = readingOf(device.id);
    if (reading.state === 'unknown') return { ...row, state: 'reading', detail: translate('extensions.loading') };
    if (reading.state === 'error') {
      const outOfDate = TOO_OLD_CODES.has((reading.error as { code?: string }).code ?? '');
      return { ...row, state: 'blocked', detail: translate(outOfDate ? 'extensions.tileNeedsApp' : 'marketDetail.deviceUnavailable') };
    }
    const entry = describe(reading.value);
    if (entry.state !== 'available') return { ...row, ...entry };
    return {
      ...row, state: entry.state, detail: entry.detail, hint: entry.hint,
      start: () => {
        if (!running.includes(device.id)) mutate({ target, plan: entry.plan });
      },
    };
  });

  return {
    open,
    onOpenChange(next: boolean) {
      setOpen(next);
      if (next) setOpened(true);
    },
    rows,
  };
}

export function MarketDevicePicker({ open, onOpenChange, rows, submitLabel, blockDismiss = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly PickerRow[];
  submitLabel?: string;
  blockDismiss?: boolean;
}) {
  const { translate } = useSessionMessages();
  const confirming = useMarketDetailConfirming();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<ReadonlySet<string>>(new Set());
  const searchable = rows.length > 10;
  const matched = searchable && search.trim()
    ? rows.filter(({ name }) => name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    : rows;
  const selectedRows = rows.filter((row) => row.state === 'available' && selected.has(row.id));
  const toggle = (id: string, checked: boolean) => setSelected((previous) => {
    const next = new Set(previous);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
  const start = () => {
    setBatch((previous) => new Set([...previous, ...selectedRows.map(({ id }) => id)]));
    setSelected(new Set());
    for (const row of selectedRows) row.start?.();
  };
  const installing = rows.some((row) => row.state === 'working');
  const searchLabel = translate('marketDetail.searchDevices');

  return (
    <Popover open={open} onOpenChange={(next, event) => {
      if (!next && (confirming || blockDismiss)) {
        event.cancel();
        return;
      }
      onOpenChange(next);
    }}>
      <PopoverTrigger render={<Button variant="outline" data-testid="market-detail-other-devices" />}>
        {translate('marketDetail.otherDevices')}
        <ChevronDown className={open ? 'rotate-180' : undefined} aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-2rem))] gap-0 rounded-2xl bg-background p-0" data-testid="market-detail-device-picker">
        <PopoverTitle className="sr-only">{translate('marketDetail.otherDevices')}</PopoverTitle>
        {searchable && (
          <div className="border-b border-border p-3">
            <SearchInput type="search" aria-label={searchLabel} placeholder={searchLabel} value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        )}
        <div className="max-h-[min(360px,45vh)] overflow-y-auto px-3 py-2">
          {matched.length > 0 ? <ul>{matched.map((row) => (
            <DeviceLine
              key={row.id}
              row={row}
              checked={row.state === 'current' || row.state === 'working' && batch.has(row.id) || selected.has(row.id)}
              onCheck={(checked) => toggle(row.id, checked)}
            />
          ))}</ul> : (
            <p className="px-2 py-3 text-foreground-muted">{translate(rows.length ? 'marketDetail.noMatchingDevices' : 'marketDetail.noOtherDevices')}</p>
          )}
        </div>
        <div className="flex justify-end border-t border-border p-3">
          <Button disabled={selectedRows.length === 0} onClick={start} data-testid="market-detail-install-selected">
            {installing && selectedRows.length === 0 && <Spinner size="sm" />}
            {submitLabel ?? translate('extensions.installAction')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeviceLine({ row, checked, onCheck }: { row: PickerRow; checked: boolean; onCheck: (checked: boolean) => void }) {
  return (
    <li className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 data-[state=blocked]:text-foreground-muted" data-device-id={row.id} data-state={row.state}>
      <Checkbox aria-label={row.name} checked={checked} disabled={row.state !== 'available'} onCheckedChange={onCheck} />
      <span className="min-w-0 flex-1 truncate" title={row.name}>{row.name}</span>
      <span className="text-right text-xs text-foreground-muted" title={row.hint}>{row.state === 'working' ? <Spinner size="sm" /> : row.detail}</span>
    </li>
  );
}
