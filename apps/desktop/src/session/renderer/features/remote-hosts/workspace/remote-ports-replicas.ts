// #6264 「端口」页签与浏览器页签的地址栏读同一份:按机器订一次,主进程报「端口表变了」时重读(❌ 定时问)。
import { replica } from '@/lib/replica';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { remotePortsChangedChannel, type RemotePortsSnapshot } from '@shared/remote-ports';
import type { SessionpageListeningPort } from '@gugu/session-core/session-record/contract';

/** The ports this computer forwards for a machine (main's table) and the ones found in its output. Pushed by main. */
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

// One subscription per machine however many tabs and browser panes show it.
const watches = new Map<string, { users: number; off: () => void }>();

/** Follow a machine's forwards while something shows them; returns stop. */
export function watchRemotePorts(deviceId: string): () => void {
  let entry = watches.get(deviceId);
  if (!entry) {
    // Read now even where no surface subscribes (the browser pane's address bar looks forwards up with `peek`).
    const readForwards = () => { void remotePortForwards.refresh(deviceId).then(() => remotePortForwards.prefetch(deviceId)); };
    const off = events.on(remotePortsChangedChannel, () => {
      readForwards();
      void machineListeningPorts.refresh(deviceId);
    }, deviceId);
    // A table kept from earlier: changes made while nobody watched are read again now; none yet: read it.
    if (remotePortForwards.peek(deviceId).state === 'value') readForwards();
    else void remotePortForwards.prefetch(deviceId);
    entry = { users: 0, off };
    watches.set(deviceId, entry);
  }
  const active = entry;
  active.users += 1;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--active.users > 0) return;
    active.off();
    watches.delete(deviceId);
  };
}

/** The machine's port a local forward stands for (one-moment, for the address bar); not read yet = none known. */
export function remoteForLocalPort(deviceId: string, localPort: number): number | null {
  const reading = remotePortForwards.peek(deviceId);
  if (reading.state !== 'value') return null;
  const forward = reading.value.forwards.find((item) => item.localPort === localPort);
  return forward ? forward.remotePort : null;
}
