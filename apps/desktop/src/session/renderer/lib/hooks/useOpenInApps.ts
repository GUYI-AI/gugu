import { useMemo } from 'react';
import { readModel, useReadModel, type Reading } from '@/lib/readModel';
import { rpc } from '@renderer/lib/ipc';
import {
  getResolvedIconPath,
  getResolvedLabel,
  OPEN_IN_APPS,
  type OpenInAppId,
  type PlatformKey,
} from '@shared/openInApps';

const iconModules = import.meta.glob('../../../assets/images/*', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function getIconUrl(iconPath: string): string | undefined {
  return iconModules[`../../../assets/images/${iconPath}`];
}

export interface OpenInApps {
  icons: Partial<Record<OpenInAppId, string>>;
  labels: Partial<Record<OpenInAppId, string>>;
  /** Which tools this device has (absent = not detected). */
  availability: Record<string, boolean>;
}

const platformModel = readModel({
  name: 'appPlatform',
  scope: 'device',
  read: () => rpc.app.getPlatform() as Promise<PlatformKey>,
  fresh: Infinity,
  persist: true,
});

const installedAppsModel = readModel({
  name: 'openInInstalledApps',
  scope: 'device',
  read: async () => (await rpc.app.checkInstalledApps()) as Record<string, boolean>,
  fresh: 5 * 60 * 1000,
  persist: true,
});

/** The "Open in" tools of this device: names and icons for its platform, and which ones are installed. */
export function useOpenInApps(): Reading<OpenInApps> {
  const platform = useReadModel(platformModel, []);
  const installed = useReadModel(installedAppsModel, []);
  return useMemo((): Reading<OpenInApps> => {
    if (platform.state !== 'value') return platform;
    if (installed.state !== 'value') return installed;
    const labels: Partial<Record<OpenInAppId, string>> = {};
    const icons: Partial<Record<OpenInAppId, string>> = {};
    for (const app of Object.values(OPEN_IN_APPS)) {
      labels[app.id] = getResolvedLabel(app, platform.value);
      const url = getIconUrl(getResolvedIconPath(app, platform.value));
      if (url) icons[app.id] = url;
    }
    return { state: 'value', value: { icons, labels, availability: installed.value }, stale: platform.stale || installed.stale, error: installed.error };
  }, [platform, installed]);
}
