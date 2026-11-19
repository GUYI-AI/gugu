import { useEffect, useState } from 'react';
import { messageForUser } from '@/lib/userFacingError';
import { SettingsNote } from '@/components/settings/SettingsPrimitives';
import { rpc } from '@renderer/lib/ipc';
import type { BrowserKernelStatus } from '@shared/browser-kernel';
import { BrowserKernelSettings } from './BrowserKernelSettings';
import { getAppSettingValueSnapshot, setAppSettingsValueInCache } from '../app-settings-client';

/** Poll only while settings is mounted; progress comes from the actual installer, never a timer estimate. */
export function BrowserKernelSettingsConnected() {
  const [status, setStatus] = useState<BrowserKernelStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const remember = (value: BrowserKernelStatus) => {
    setStatus(value);
    // An in-progress choice is visual only: new tabs adopt it after installation commits the preference.
    if (value.phase !== 'idle') return;
    const browser = getAppSettingValueSnapshot('browser');
    if (browser && browser.kernel !== value.selected) setAppSettingsValueInCache('browser', { ...browser, kernel: value.selected });
  };
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await rpc.browser.kernelStatus();
        if (!closed) { remember(value); setReadError(null); }
      } catch (failure) { if (!closed) setReadError(failure); }
      if (!closed) timer = setTimeout(() => { void refresh(); }, 500);
    };
    void refresh();
    return () => { closed = true; clearTimeout(timer); };
  }, []);
  return <>
    {status && <BrowserKernelSettings status={status} onError={setError} action={async action => {
      remember(await rpc.browser.kernelAction(action));
      setError(null);
    }} />}
    {(error != null || readError != null) && <SettingsNote tone="danger">{messageForUser(error ?? readError)}</SettingsNote>}
  </>;
}
