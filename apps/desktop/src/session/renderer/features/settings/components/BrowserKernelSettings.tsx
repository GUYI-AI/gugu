import { useState } from 'react';
import { messageForUser } from '@/lib/userFacingError';
import { SettingsRow, SettingsNote } from '@/components/settings/SettingsPrimitives';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { BrowserKernelStatus } from '@shared/browser-kernel';

type Action = 'builtin' | 'download-and-switch' | 'cancel' | 'check-update' | 'remove';
type Props = { status: BrowserKernelStatus; action(value: Action): Promise<void>; onError(error: unknown): void };

export function browserKernelSize(bytes: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(bytes / 1_000_000)} MB`;
}

/** The initial choice asks beside the control; consent is the only action that starts a download. */
export function BrowserKernelSettings({ status, action, onError }: Props) {
  const { translate } = useSessionMessages();
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!status.supported || !status.asset) return null;
  const pending = status.phase !== 'idle';
  const downloading = status.phase === 'downloading';
  const percent = Math.min(100, Math.max(0, Math.floor(status.receivedBytes * 100 / Math.max(1, status.totalBytes))));
  const perform = (value: Action) => {
    setConsent(false);
    setSaving(true);
    void action(value).catch(onError).finally(() => setSaving(false));
  };
  const standalone = <ToggleGroupItem value="standalone" disabled={saving || pending}>
    {translate('browserSettings.kernelStandalone')}
  </ToggleGroupItem>;
  const description = downloading ? translate('browserSettings.kernelDownloading', { percent })
    : status.phase === 'installing' ? translate('browserSettings.kernelInstalling')
    : status.phase === 'cancelling' ? translate('browserSettings.kernelCancelling')
    : status.installation ? translate('browserSettings.kernelInstalled', {
      version: status.installation.version, size: browserKernelSize(status.installation.installedBytes),
    }) : messageForUser(status.error);

  return <>
    <SettingsRow title={translate('browserSettings.kernel')} control={
      <Popover open={consent} onOpenChange={open => setConsent(open && !pending && !status.installation)}>
        <ToggleGroup value={[status.selected]} size="sm" spacing={1}
          aria-label={translate('browserSettings.kernel')} className="border-0 bg-background-secondary p-1"
          onValueChange={([value]) => {
            if (value === 'builtin') perform('builtin');
            else if (value === 'standalone') {
              if (status.installation) perform('download-and-switch');
              else setConsent(true);
            }
          }}>
          <ToggleGroupItem value="builtin" disabled={saving || status.phase === 'cancelling'}>
            {translate('browserSettings.kernelBuiltin')}
          </ToggleGroupItem>
          {status.installation ? standalone : <PopoverTrigger render={standalone} />}
        </ToggleGroup>
        <PopoverContent align="end" sideOffset={8} className="max-w-[calc(100vw-32px)] w-[340px] gap-2 p-4">
          <PopoverTitle>{translate('browserSettings.kernelConfirmTitle')}</PopoverTitle>
          <PopoverDescription className="leading-5">{translate('browserSettings.kernelConfirmDescription', {
            size: browserKernelSize(status.asset.downloadBytes),
          })}</PopoverDescription>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConsent(false)}>{translate('browserSettings.kernelLater')}</Button>
            <Button size="sm" disabled={saving} onClick={() => perform('download-and-switch')}>
              {translate('browserSettings.kernelDownloadAndSwitch')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    } />
    {(pending || status.installation || status.error) && <SettingsRow title={translate('browserSettings.kernelStandaloneRow')}
      description={description} control={<div className="flex items-center gap-2">
        {pending ? <>
          {downloading && <progress className="h-1 w-[120px] overflow-hidden rounded-sm accent-foreground"
            aria-label={translate('browserSettings.kernelDownloading', { percent })} max={status.totalBytes} value={status.receivedBytes} />}
          <Button variant="outline" size="sm" disabled={saving || status.phase === 'cancelling'} onClick={() => perform('cancel')}>
            {translate('browserSettings.kernelCancel')}
          </Button>
        </> : status.installation ? <>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => perform('check-update')}>{translate('browserSettings.kernelCheckUpdate')}</Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => perform('remove')}>{translate('browserSettings.delete')}</Button>
        </> : null}
      </div>} />}
    {status.error && status.installation && <SettingsNote tone="danger">{messageForUser(status.error)}</SettingsNote>}
    {status.update && <SettingsNote>{translate(status.update.reviewed ? 'browserSettings.kernelCurrent' : 'browserSettings.kernelUnreviewedUpdate', { version: status.update.version })}</SettingsNote>}
  </>;
}
