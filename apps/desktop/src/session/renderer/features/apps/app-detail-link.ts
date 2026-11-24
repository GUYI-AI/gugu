import type { AppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { cachedDevicesAccount, readCachedDevices } from '@/store/devicesCache';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { rpcOn } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { LOCAL_DEVICE_SCOPE } from '@renderer/features/remote-hosts/device-scope-store';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { currentAppsLocation, openAppsLocation } from './apps-location';

/** Validate the named host before opening a detail that can act on it. */
export async function openAppDetailLink(target: AppDetailLink, ownerId: string, isCurrent = () => true) {
  let scope = LOCAL_DEVICE_SCOPE;
  if (target.deviceId) {
    const device = cachedDevicesAccount() === ownerId ? readCachedDevices().find((row) => row.device_id === target.deviceId) : undefined;
    if (!device) throw new Error(`Device ${target.deviceId} is not registered to your account.`);
    if (!device.is_current_device) {
      if (!remoteHostsStore.device(target.deviceId)) throw new Error(`Device ${target.deviceId} is unavailable; open Devices and reconnect it.`);
      scope = target.deviceId;
    }
    if (target.kind === 'app-detail' && target.variant) {
      const result = await rpcOn(scope === LOCAL_DEVICE_SCOPE ? null : scope).extensions.variants(target.extensionId);
      if (!result.success || !result.data) throw new Error(result.error ?? 'The installed App is unavailable on that device.');
      if (!result.data.variants.some((row) => row.name === target.variant)) throw new Error(`Variant ${target.variant} is no longer installed on that device.`);
    }
  }
  if (!isCurrent()) return;
  revealSessionpage();
  // Every way into the Apps page names a place on it (apps-location); a link goes from where the page was last.
  const here = currentAppsLocation();
  const device = scope === LOCAL_DEVICE_SCOPE ? undefined : scope;
  if (target.kind === 'agent-app-detail') {
    // Over the page as it stands it closes back to it; over the Installed page it is a step, so closing returns to it.
    const overPage = appState.navigation.currentViewId === 'apps' && !here.installed;
    appState.navigation.navigate('apps', {
      location: { ...here, installed: undefined },
      agentDetail: { ...target, deviceId: device },
      ...(overPage ? { agentDetailFrom: 'apps' } : {}),
    });
  } else {
    openAppsLocation({
      ...here,
      installed: undefined,
      deviceId: device,
      detail: { extensionId: target.extensionId, ...(target.variant ? { variant: target.variant } : {}), ...(target.fromApp ? { fromApp: true } : {}) },
    });
  }
}
