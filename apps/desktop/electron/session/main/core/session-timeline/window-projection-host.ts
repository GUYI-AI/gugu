import type Database from 'better-sqlite3';
import { opendir } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createWindowProjectionAdapter } from './window-projection-adapter';
import { openWindowProjectionGateway } from './window-projection-gateway';
import { openWindowCommitPins } from './window-commit-pins';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { prepareWindowCommitLayout } from './window-commit-layout';
import { readWindowCommitCollectionGuard } from './window-commit-collection-guard';
import { openWindowCommitGc } from './window-commit-gc-discovery';
import { createWindowPackFileSweeper, sweepWindowPackGroups } from './window-pack-store';

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
  // A development-era cache layout is cleared under this gateway before pins,
  // projections or the committed-event writer can touch the namespace.
  const prepared = gateway.run(() => prepareWindowCommitLayout({ directory: input.directory, connection: input.connection, proof: gateway.proof }));
  // A version is collectable only when no source write or projection build intent remains.
  const opening = prepared.then(() => openWindowCommitPins({ directory: input.directory, proof: gateway.proof, receipts,
    canCollect: async (version, budget, signal) => await readWindowCommitCollectionGuard(input.directory, version, budget, signal) === 'clear' }));
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
  // One bounded collection pass: at most SCOPES session scopes and STEPS
  // collector steps each, then at most 8 orphaned packs. Scope enumeration keeps
  // one directory handle across passes and starts over after reaching its end.
  const SCOPES = 16, STEPS = 64;
  let scopes: Dir | undefined, collecting: Promise<void> | undefined, stopped = false;
  const packFiles = createWindowPackFileSweeper(input.directory, input.connection);
  async function nextScopes() {
    const found: string[] = [];
    if (!scopes) {
      try { scopes = await opendir(join(input.directory, 'source-versions'), { bufferSize: 1 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found; throw error; }
    }
    while (found.length < SCOPES) {
      const entry = await scopes.read();
      if (!entry) { const done = scopes; scopes = undefined; await done.close(); break; }
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) found.push(entry.name);
    }
    return found;
  }
  async function pass() {
    const pins = await opening;
    for (const scope of await nextScopes()) {
      if (stopped) return;
      const gc = await gateway.run(() => openWindowCommitGc({ directory: input.directory, scope, pins, connection: input.connection }));
      try {
        for (let step = 0; step < STEPS && !stopped; step++) {
          const result = await gateway.run(() => gc.run(createWindowBudget()));
          if (result.kind === 'end') break;
        }
      } finally { await gc.close(); }
    }
    if (stopped) return;
    await gateway.run(() => sweepWindowPackGroups(input.directory, input.connection, gateway.proof));
    for (let step = 0; step < STEPS && !stopped; step++)
      if (await gateway.run(() => packFiles.step(gateway.proof)) === 'end') break;
  }
  function collect() {
    return collecting ??= pass().finally(() => { collecting = undefined; });
  }
  return {
    /** One bounded reclamation pass; concurrent calls join the running pass. */
    collect,
    /** Resolves once the committed cache layout is current; writers wait on it. */
    prepared: prepared.then(() => undefined),
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
      stopped = true; await collecting?.catch(() => {}); const handle = scopes; scopes = undefined; await handle?.close(); await packFiles.close();
      await Promise.allSettled([...owners.keys()].map(close));
      await ready.catch(() => {}); await gateway.close();
    },
  };
}
