// #6264 「端口」页签与浏览器页签的地址栏读同一份:按机器订一次,主进程报「端口表变了」时重读(❌ 定时问)。
import { replica } from '@/lib/replica';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { remotePortsChangedChannel, type RemotePortsSnapshot } from '@shared/remote-ports';
import type { SessionpageListeningPort } from '@gugu/session-core/session-record/contract';

/**
 * The ports this computer forwards for a machine (main's table) and the ones found in its output. Pushed by main: one
 * subscription per machine while the ports tab or a browser pane (`hold`) shows it; a table kept from earlier is read
 * again when it opens (changes made while nobody watched).
 */
export const remotePortForwards = replica({
  name: 'remotePortForwards',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, deviceId: string): Promise<RemotePortsSnapshot> => {
    const result = await rpc.remotePorts.list({ deviceId });
    if (!result.success) throw new Error(`remote ports of ${deviceId} not listed (${result.error.type})`, { cause: result.error });
    return result.data;
  },
  fresh: Infinity,
  watch: {
    group: (deviceId) => deviceId,
    start: (_owner, deviceId) => events.on(remotePortsChangedChannel, () => {
      // Read even where no surface subscribes (the browser pane's address bar looks forwards up with `peek`).
      void remotePortForwards.refresh(deviceId).then(() => remotePortForwards.prefetch(deviceId));
      void machineListeningPorts.refresh(deviceId);
    }, deviceId),
  },
});

/** What programs listen on that machine right now: asked each time the ports tab opens or the table changes. */
export const machineListeningPorts = replica({
  name: 'machineListeningPorts',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, deviceId: string): Promise<{ supported: boolean; ports: SessionpageListeningPort[] }> => {
    const result = await rpcOn(deviceId).machine.listeningPorts();
    if (!result.success) throw new Error(result.error.message, { cause: result.error });
    return { supported: result.data.supported, ports: result.data.ports };
  },
  fresh: 0,
});

/** Follow a machine's forwards for the address bar (shows nothing itself): the table is read now and kept current; returns stop. */
export function holdRemotePorts(deviceId: string): () => void {
  const release = remotePortForwards.hold(deviceId);
  void remotePortForwards.prefetch(deviceId);
  return release;
}

/** The machine's port a local forward stands for (one-moment, for the address bar); not read yet = none known. */
export function remoteForLocalPort(deviceId: string, localPort: number): number | null {
  const reading = remotePortForwards.peek(deviceId);
  if (reading.state !== 'value') return null;
  const forward = reading.value.forwards.find((item) => item.localPort === localPort);
  return forward ? forward.remotePort : null;
}
