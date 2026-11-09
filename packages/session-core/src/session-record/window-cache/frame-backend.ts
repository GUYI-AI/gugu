import { resolve } from 'node:path';
import type { WindowFrameKey, WindowFrameRead } from './frame';
import type { WindowBudget } from './types';

/** Host-owned cache namespace. This carries no body, worker or database handle
 * across RPC. Each registration has one lifetime and can only release itself. */
export type WindowFrameBackend = {
  read(key: WindowFrameKey, budget: WindowBudget): Promise<WindowFrameRead>;
  write(key: WindowFrameKey, packet: Uint8Array): Promise<void>;
};
const backends = new Map<string, WeakRef<WindowFrameBackend>>();
const collected = new FinalizationRegistry<{ path: string; ref: WeakRef<WindowFrameBackend> }>(({ path, ref }) => {
  if (backends.get(path) === ref) backends.delete(path);
});
export function windowFrameBackend(directory: string) { return backends.get(resolve(directory))?.deref(); }
export function registerWindowFrameBackend(directory: string, backend: WindowFrameBackend): () => void {
  const path = resolve(directory);
  if (backends.get(path)?.deref()) throw new Error('A frame backend already owns this namespace');
  const ref = new WeakRef(backend); backends.set(path, ref); collected.register(backend, { path, ref }, ref);
  return () => { if (backends.get(path) === ref) backends.delete(path); collected.unregister(ref); };
}
