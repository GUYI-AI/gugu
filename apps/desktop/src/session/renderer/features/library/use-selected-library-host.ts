import { useMemo } from 'react';
import { useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { libraryDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { createRemoteLibraryHost, LOCAL_LIBRARY_HOST, type LibraryHost } from './library-host';

/** 资源库此刻看的是哪台机器(选的那台不在名下了就回落本机)。在 observer 里调用。 */
export function useSelectedLibraryHost(): LibraryHost {
  const selected = useSelectedRemoteDevice(libraryDeviceStore);
  const deviceId = selected?.deviceId ?? null;
  const label = selected?.device.label ?? '';
  const online = selected?.device.isOnline ?? false;
  const lastSeenAt = selected?.device.lastSeenAt ?? null;
  const hostKind = selected?.device.hostKind;
  return useMemo(
    () =>
      deviceId
        ? createRemoteLibraryHost({ deviceId, deviceLabel: label, online, lastSeenAt, hostKind }, (id, initialPath) =>
            remoteHostsStore.pickFolder(id, initialPath)
          )
        : LOCAL_LIBRARY_HOST,
    // device 对象本身每次心跳都换;按它身上会变、页面会用到的那几格重建。
    [deviceId, label, online, lastSeenAt, hostKind]
  );
}
