import { useEffect } from 'react';
import { events } from '@renderer/lib/ipc';
import { browserKernelSelectionChannel } from '@shared/events/browserEvents';
import { getAppSettingValueSnapshot, invalidateAppSettingsKey, setAppSettingsValueInCache } from '../settings/app-settings-client';

/** Remains mounted with the shell, so a finished background download also reaches newly-created tabs. */
export function useBrowserKernelPreferenceEvents() {
  useEffect(() => events.on(browserKernelSelectionChannel, ({ kernel }) => {
    const browser = getAppSettingValueSnapshot('browser');
    if (browser) setAppSettingsValueInCache('browser', { ...browser, kernel });
    else invalidateAppSettingsKey('browser');
  }), []);
}
