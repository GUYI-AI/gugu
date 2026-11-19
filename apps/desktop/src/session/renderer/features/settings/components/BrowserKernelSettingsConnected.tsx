import { useState } from 'react';
import { replica, useReplica } from '@/lib/replica';
import { messageForUser } from '@/lib/userFacingError';
import { SettingsNote } from '@/components/settings/SettingsPrimitives';
import { Unknown } from '@/components/ui/Unknown';
import { rpc } from '@renderer/lib/ipc';
import type { BrowserKernelStatus } from '@shared/browser-kernel';
import { BrowserKernelSettings } from './BrowserKernelSettings';
import { getAppSettingValueSnapshot, setAppSettingsValueInCache } from '../app-settings-client';

/** Device-owned status, without a snapshot: installation progress must be read from the current installer. */
const kernelStatus = replica({
  name: 'browserKernelStatus', scope: 'device', refreshEvery: 500, keep: 60_000,
  read: async () => {
    const status = await rpc.browser.kernelStatus();
    // New tabs adopt a choice only after installation commits the preference.
    if (status.phase === 'idle') {
      const browser = getAppSettingValueSnapshot('browser');
      if (browser && browser.kernel !== status.selected) setAppSettingsValueInCache('browser', { ...browser, kernel: status.selected });
    }
    return status;
  },
});

export function BrowserKernelSettingsConnected() {
  const reading = useReplica(kernelStatus, []);
  const [error, setError] = useState<unknown>(null);
  const status: BrowserKernelStatus | null = reading.state === 'value' ? reading.value : null;
  const readError = reading.state === 'unknown' ? null : reading.error;
  return <>
    {reading.state === 'unknown' && <Unknown className="h-8 w-full" />}
    {status && <BrowserKernelSettings status={status} onError={setError} action={async action => {
      await rpc.browser.kernelAction(action);
      // Invalidate instead of replacing a concurrently polled value with an older action response.
      await kernelStatus.refresh();
      setError(null);
    }} />}
    {(error != null || readError != null) && <SettingsNote tone="danger">{messageForUser(error ?? readError)}</SettingsNote>}
  </>;
}
