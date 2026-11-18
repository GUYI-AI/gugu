import type { Debugger, WebContents } from 'electron';

type Lease = { users: number; own: boolean; detached: () => void };
const leases = new WeakMap<Debugger, Lease>();

/** Counters and traces share one transport. Releasing either must not disconnect the other (or DevTools). */
export function acquireMonitorDebugger(contents: WebContents): () => void {
  const transport = contents.debugger;
  let lease = leases.get(transport);
  if (!lease) {
    const own = !transport.isAttached();
    if (own) transport.attach('1.3');
    const detached = () => { leases.delete(transport); };
    lease = { users: 0, own, detached };
    leases.set(transport, lease);
    transport.once('detach', detached);
  }
  lease.users += 1;
  const held = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.users -= 1;
    if (held.users || leases.get(transport) !== held) return;
    leases.delete(transport);
    transport.removeListener('detach', held.detached);
    if (held.own && !contents.isDestroyed() && transport.isAttached()) transport.detach();
  };
}
