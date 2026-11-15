// #6264 弹窗(集成连接、GitHub 连接 / 设备码)挂在应用根上,不在资源库那棵树里 —— 拿不到资源库选的那台机器。
// 打开它的那一页把自己的 `LibraryHost` 作为参数带过来,弹窗里用这一层重新挂上,弹窗里的取数钩子就问同一台机器。
// 助理授权动作自带宿主准备流程，不能因设备休眠在入口把它禁用。
import { observer } from 'mobx-react-lite';
import { createContext, useContext, type ReactNode } from 'react';
import { ConnectionStatus } from '@/components/connection/ConnectionStatus';
import { headerConnectionState } from '@renderer/features/remote-hosts/header-connection-state';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { LibraryHostProvider, type LibraryHost } from './library-host';

/** The machine a dialog acts on when it is not this computer (read by the dialog's title). */
const DialogMachineContext = createContext<{ deviceId: string; deviceLabel: string; unavailable: boolean } | null>(null);

export const LibraryHostScope = observer(function LibraryHostScope({
  host,
  children,
}: {
  host?: LibraryHost | null;
  children: ReactNode;
}) {
  // 没带:应用根上那一份就是本机的,原样用。带了本机的 owner 宿主:它自带账号元数据和动作,也要挂上。
  if (!host) return <>{children}</>;
  if (!host.remote) return <LibraryHostProvider value={host}><IntegrationsProvider>{children}</IntegrationsProvider></LibraryHostProvider>;
  const online = remoteHostsStore.device(host.remote.deviceId)?.isOnline ?? host.remote.online;
  const unavailable = !online && !host.prepareAssistantAction;
  return (
    <LibraryHostProvider value={host}>
      <IntegrationsProvider>
        <DialogMachineContext.Provider value={{ deviceId: host.remote.deviceId, deviceLabel: host.remote.deviceLabel, unavailable }}>
          {children}
        </DialogMachineContext.Provider>
      </IntegrationsProvider>
    </LibraryHostProvider>
  );
});

/**
 * Which machine the dialog acts on and its connection state, in the dialog's own title (Q2): the dialog covers the
 * page heading, so the reason its form is greyed out has to be readable here. This computer = nothing.
 */
export const LibraryHostDialogStatus = observer(function LibraryHostDialogStatus() {
  const machine = useContext(DialogMachineContext);
  const state = machine ? headerConnectionState(remoteHostsStore.connectionState(machine.deviceId)) : null;
  if (!machine || !state) return null;
  return (
    <ConnectionStatus
      state={state}
      lastSeenAt={remoteHostsStore.device(machine.deviceId)?.lastSeenAt ?? null}
      subject={machine.deviceLabel}
      testId="dialog-machine-status"
    />
  );
});

/**
 * The part of a dialog that acts on that machine: greyed out while it cannot be reached. Cancel and the title's ✕ stay
 * outside it — closing never needs the machine (a disabled fieldset would disable them too, leaving only Esc).
 */
export function LibraryHostFieldset({ children }: { children: ReactNode }) {
  const machine = useContext(DialogMachineContext);
  return (
    <fieldset disabled={machine?.unavailable ?? false} className="contents" data-testid="library-host-scope">
      {children}
    </fieldset>
  );
}
