import type Database from 'better-sqlite3';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createWindowProjectionAdapter } from './window-projection-adapter';
import { openWindowProjectionGateway } from './window-projection-gateway';
import { openWindowCommitPins } from './window-commit-pins';
import { createWindowCommitReceipts } from './window-commit-receipt';

export type WindowProjectionOwner = { identity: object; sessionId: string; signal?: AbortSignal; assertCurrent(): void };
const failure = () => Object.assign(new Error('The projection subscription was released'), { code: 'unsubscribed' });

/** One gateway for the real connection, not one gateway per window. Register
 * only host-owned identities; a renderer's subscription UUID is never a pin owner.
 * Pending cleanup remains retained and capacity charged after durable I/O failure. */
export function createWindowProjectionHost(input: {
  connection: Database.Database; directory: string; lockDirectory?: string;
  report(error: unknown): void;
}) {
  type Owner = WindowProjectionOwner & { closed: boolean; cleanup?: Promise<void> };
  const owners = new Map<object, Owner>(), retired = new WeakSet<object>();
  const gateway = openWindowProjectionGateway(input.connection, input.directory, input.lockDirectory);
  const receipts = createWindowCommitReceipts(input.connection);
  // The collector is deliberately closed until its actual source/build intent
  // guards are supplied by the GC integration. Read pins are durable now.
  const opening = openWindowCommitPins({ directory: input.directory, proof: gateway.proof, receipts, canCollect: async () => false });
  const ready = opening.then(pins => {
    function authority(identity: object) {
      gateway.proof.assertHeld(); const owner = owners.get(identity);
      if (!owner || owner.closed) throw failure(); owner.assertCurrent(); return owner;
    }
    return createWindowProjectionAdapter({ directory: input.directory, receipts,
      authorize(identity, position) {
        const owner = authority(identity), receipt = receipts.bySource(position.projectionId.split('/')[0]);
        if (!receipt || receipt.sessionId !== owner.sessionId) throw failure(); return receipt;
      },
      assertOwner(identity, receipt) { if (authority(identity).sessionId !== receipt.sessionId) throw failure(); },
      async acquire(owner, version, budget, signal) {
        const release = await gateway.run(() => pins.acquire(owner, version, budget, signal));
        return (next, abort) => gateway.run(() => release(next, abort));
      },
      releaseOwner: (owner, budget, signal) => gateway.run(() => pins.releaseOwner(owner, budget, signal)),
      report: input.report,
    });
  });
  // Preserve the initialization error for callers and never leave an unhandled
  // rejected promise if a window closes while the epoch is being initialized.
  void ready.catch(error => { try { input.report(error); } catch { /* diagnostics only */ } });
  function selected(owner: WindowProjectionOwner) {
    owner.assertCurrent();
    if (retired.has(owner.identity)) throw failure();
    let value = owners.get(owner.identity);
    if (!value) {
      if (owners.size >= 32) throw Object.assign(new Error('Projection owner cleanup is at capacity'), { code: 'capacity' });
      value = { ...owner, closed: false }; owners.set(owner.identity, value);
    }
    if (value.closed || value.sessionId !== owner.sessionId) throw failure();
    return value;
  }
  function close(identity: object) {
    retired.add(identity);
    const owner = owners.get(identity); if (!owner) return Promise.resolve();
    owner.closed = true;
    if (owner.cleanup) return owner.cleanup;
    const cleanup = ready.then(async adapter => {
      let complete = false;
      while (!complete) {
        const result = await gateway.run(() => adapter.close(identity, createWindowBudget()));
        complete = result.complete;
        if (!complete) await adapter.settled(identity);
      }
      if (owners.get(identity) === owner) owners.delete(identity);
    }).finally(() => { if (owner.cleanup === cleanup) owner.cleanup = undefined; });
    owner.cleanup = cleanup;
    void cleanup.catch(error => { try { input.report(error); } catch { /* preserve the cleanup record */ } });
    return cleanup;
  }
  return {
    /** Collectors share this epoch and kernel guard; they must never initialize
     * a second registry while a resident read gateway is alive. */
    withPins<T>(run: (pins: Awaited<typeof opening>) => Promise<T>) { return gateway.run(async () => run(await opening)); },
    assertCurrent(owner: WindowProjectionOwner) {
      gateway.proof.assertHeld(); owner.assertCurrent();
      if (retired.has(owner.identity) || owners.get(owner.identity)?.closed) throw failure();
    },
    async run<T>(inputOwner: WindowProjectionOwner, budget: WindowBudget,
      operation: (adapter: Awaited<typeof ready>, identity: object, budget: WindowBudget) => Promise<T>) {
      inputOwner.assertCurrent(); if (retired.has(inputOwner.identity)) throw failure();
      // Retry one retained closed owner before capacity admission. Joining an
      // in-flight cleanup is safe; its record clears before its promise settles.
      // Failure retains the record and capacity for the next request's retry.
      const previous = [...owners.values()].find(value => value.closed);
      if (previous) await close(previous.identity).catch(() => {});
      const owner = selected(inputOwner);
      const adapter = await ready; owner.assertCurrent();
      if (owner.closed) throw failure();
      const value = await gateway.run(() => operation(adapter, owner.identity, budget));
      owner.assertCurrent(); if (owner.closed) throw failure(); gateway.proof.assertHeld(); return value;
    },
    close,
    async shutdown() {
      await Promise.allSettled([...owners.keys()].map(close));
      await ready.catch(() => {}); await gateway.close();
    },
  };
}
