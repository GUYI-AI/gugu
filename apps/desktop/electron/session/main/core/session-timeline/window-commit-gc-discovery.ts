import { opendir } from 'node:fs/promises';
import type { Dir, Dirent } from 'node:fs';
import { join } from 'node:path';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { openWindowCommitCollector } from './window-commit-gc';
import type { openWindowCommitPins } from './window-commit-pins';
import type { WindowReceiptDatabase } from './window-commit-receipt';

type Pins = Awaited<ReturnType<typeof openWindowCommitPins>>;
/** A background pass, never a front-page prerequisite. The directory handle
 * holds one entry at a time. Restart may revisit surviving metadata entries;
 * actual deletion progress is durable in the collector's fixed checkpoint. */
export function createWindowCommitGcDiscovery(input: { directory: string; scope: string; pins: Pins }) {
  if (!/^[a-f0-9]{64}$/.test(input.scope)) throw new Error('Invalid discovery scope');
  let handle: Dir | undefined, pending: Dirent | undefined, closed = false, tail = Promise.resolve();
  function serial<T>(run: () => Promise<T>) { const next = tail.then(run, run); tail = next.then(() => {}, () => {}); return next; }
  async function closeHandle() { const previous = handle; handle = undefined; if (previous) await previous.close(); }
  return {
    next(budget: WindowBudget, signal?: AbortSignal) {
      return serial(async () => {
        if (closed) throw new Error('GC discovery is closed');
        try {
          return await input.pins.withGateway(budget, async check => {
            const held = () => { check(); if (closed) throw new Error('GC discovery is closed'); };
            held();
            if (!handle && !pending) {
              try { handle = await opendir(join(input.directory, 'source-versions', input.scope), { bufferSize: 1 }); }
              catch (error) { held(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'end' as const }; throw error; }
              held();
            }
            const start = performance.now(); let examined = 0;
            for (; examined < 64; examined++) {
              held();
              if (!pending) {
                // Admission is before the actual metadata read. A cancelled
                // read retains its one returned entry for the next request.
                budget.charge('examinedRecords', 1);
                if (!handle) handle = await opendir(join(input.directory, 'source-versions', input.scope), { bufferSize: 1 });
                pending = await handle.read() ?? undefined; held();
                if (!pending) { await closeHandle(); held(); return { kind: 'end' as const }; }
              }
              const entry = pending; pending = undefined;
              const match = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.version$/.exec(entry.name);
              if (match && entry.isFile()) return { kind: 'candidate' as const, sourceId: match[1] };
              if (!entry.isFile() || !(entry.name === '.ready' || /^[a-f0-9-]{36}\.version\.tmp$/.test(entry.name)))
                throw new Error('Unexpected source catalog artifact');
              if (performance.now() - start >= 5) break;
            }
            return { kind: 'continuation' as const };
          }, signal);
        } catch (error) { await closeHandle(); throw error; }
      });
    },
    close() { closed = true; return serial(async () => { pending = undefined; await closeHandle(); }); },
  };
}

/** One caller-owned batch and budget. Protected versions remain for later
 * passes; reaching end closes this pass, and the next call discovers anew. */
export async function openWindowCommitGc(input: { directory: string; scope: string; pins: Pins; connection: WindowReceiptDatabase }) {
  const collector = await openWindowCommitCollector(input), discovery = createWindowCommitGcDiscovery(input);
  let tail = Promise.resolve(), closed = false;
  return {
    run(budget: WindowBudget, signal?: AbortSignal) {
      if (closed) return Promise.reject(new Error('GC is closed'));
      const next = tail.then(async () => {
        const resumed = await collector.step(undefined, budget, signal);
        if (resumed.kind !== 'idle') return resumed;
        const found = await discovery.next(budget, signal);
        return found.kind === 'candidate' ? collector.step(found.sourceId, budget, signal) : found;
      });
      tail = next.then(() => {}, () => {}); return next;
    },
    close() { closed = true; return tail.then(() => discovery.close(), () => discovery.close()); },
  };
}
