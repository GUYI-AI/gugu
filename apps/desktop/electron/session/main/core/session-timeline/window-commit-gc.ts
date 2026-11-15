import { opendir, realpath, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { readWindowFrame, writeWindowFrame, syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { readWindowCommitSourceCatalog, removeWindowCommitSourceCatalog } from './window-commit-source-catalog';
import { windowCommitProjectionDirectory } from './window-commit-projection-disk';
import { assertWindowCommitSource, windowCommitSourcePath } from './window-commit-source';
import type { openWindowCommitPins } from './window-commit-pins';
import type { WindowReceiptDatabase, WindowCommitReceipt } from './window-commit-receipt';

type Pins = Awaited<ReturnType<typeof openWindowCommitPins>>;
type Job = { version: 1; namespace: string; sourceId: string; phase: 'collect' | 'catalog' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tails = new Map<string, Promise<void>>();
function serial<T>(key: string, run: () => Promise<T>) {
  const next = (tails.get(key) ?? Promise.resolve()).then(run, run), tail = next.then(() => {}, () => {});
  tails.set(key, tail); void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); }); return next;
}

/** One scope-owned job, addressed directly after restart. A batch removes at
 * most 64 directory entries and yields after 5 ms; it never reads a source body.
 * A durable collecting claim blocks new readers before any artifact is removed. */
export async function openWindowCommitCollector(input: { directory: string; scope: string; pins: Pins; connection: WindowReceiptDatabase }) {
  if (!/^[a-f0-9]{64}$/.test(input.scope)) throw new Error('Invalid collection scope');
  const directory = await realpath(input.directory), { scope, pins, connection } = input;
  const key = { scope, sourceLineage: scope, decoderVersion: 1, kind: 'head' as const, cursor: 'version:gc' };
  const address = join(directory, windowFrameName(key));
  async function readJob(b: WindowBudget, signal?: AbortSignal): Promise<Job | null> {
    return pins.withGateway(b, async check => {
      const found = await readWindowFrame(directory, key, b); check();
      if (found.kind === 'miss') {
        if (found.reason === 'not_found') return null;
        throw found.reason === 'io' ? found.error : new Error('Invalid collection checkpoint');
      }
      const job = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(found.bytes)) as Job;
      if (job?.version !== 1 || job.namespace !== pins.namespace || !uuid.test(job.sourceId)
        || !['collect', 'catalog'].includes(job.phase)) throw new Error('Invalid collection checkpoint binding');
      return job;
    }, signal);
  }
  async function save(job: Job, b: WindowBudget, signal?: AbortSignal) {
    await pins.withGateway(b, async check => { check(); await writeWindowFrame(directory, key, Buffer.from(JSON.stringify(job))); check(); }, signal);
  }
  async function removeProjection(receipt: WindowCommitReceipt, check: () => void) {
    const path = windowCommitProjectionDirectory(directory, receipt.binding);
    check(); let entries;
    try { entries = await opendir(path, { bufferSize: 1 }); }
    catch (error) { check(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    let complete = false; const start = performance.now();
    try {
      for (let count = 0; count < 64; count++) {
        check(); const entry = await entries.read(); check();
        if (!entry) { complete = true; break; }
        if (!entry.isFile() || !/^(?:\.ready|[a-f0-9]{64}\.frame(?:\.[a-f0-9-]{36}\.tmp)?)$/.test(entry.name))
          throw new Error('Unexpected artifact in projection namespace');
        await rm(join(path, entry.name)); check();
        if (performance.now() - start >= 5) break;
      }
    } finally { await entries.close(); }
    check(); await syncWindowDirectory(path); check();
    if (complete) { await rmdir(path); check(); await syncWindowDirectory(join(path, '..')); check(); }
    return complete;
  }
  async function assertSource(receipt: WindowCommitReceipt, check: () => void) {
    check();
    try { await assertWindowCommitSource(directory, receipt.binding, receipt.source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A crashed batch may already have unlinked the owned file. A present
    // replacement must never inherit that receipt's physical identity.
    check();
  }
  return {
    /** undefined resumes the fixed checkpoint; a new candidate comes only from
     * the bounded source catalog discovery port, never renderer-supplied paths. */
    step(sourceId: string | undefined, budget: WindowBudget, signal?: AbortSignal) {
      return serial(`${directory}/${scope}`, async () => {
        if (sourceId !== undefined && !uuid.test(sourceId)) throw new Error('Invalid collection source id');
        let job = await readJob(budget, signal);
        if (job && sourceId !== undefined && sourceId !== job.sourceId) return { kind: 'busy' as const, sourceId: job.sourceId };
        if (!job && sourceId === undefined) return { kind: 'idle' as const };
        const id = job?.sourceId ?? sourceId!;
        if (job?.phase !== 'catalog') {
          const catalog = await pins.withGateway(budget, async check => {
            const found = await readWindowCommitSourceCatalog(directory, scope, id, budget, signal); check(); return found;
          }, signal);
          if (catalog.kind !== 'hit') {
            if (!job) return { kind: 'absent' as const, sourceId: id };
            throw new Error('Collection provenance is missing');
          }
          const version = { receipt: catalog.receipt }, state = await pins.beginCollection(version, budget, signal);
          if (state !== 'collecting' && state !== 'collected') return { kind: state, sourceId: id };
          job ??= { version: 1, namespace: pins.namespace, sourceId: id, phase: 'collect' };
          await save(job, budget, signal);
          if (state === 'collecting') {
            const complete = await pins.withCollection(version, budget, async check => {
              await assertSource(catalog.receipt, check);
              if (!await removeProjection(catalog.receipt, check)) return false;
              await assertSource(catalog.receipt, check);
              check(); await rm(windowCommitSourcePath(directory, catalog.receipt.binding), { force: true }); check();
              await syncWindowDirectory(directory); check();
              connection.prepare(`DELETE FROM session_window_commit_receipts WHERE source_id=?
                AND NOT EXISTS (SELECT 1 FROM session_window_commit_positions WHERE source_id=?)`).run(id, id);
              if (connection.prepare('SELECT 1 FROM session_window_commit_receipts WHERE source_id=?').get(id)) throw new Error('Collection receipt is still current');
              return true;
            }, signal);
            if (!complete) return { kind: 'progress' as const, sourceId: id };
            await pins.finishCollection(version, budget, signal);
          }
          await pins.forgetCollected(version, budget, signal);
          // Keep provenance until the pin head is gone. This small phase proves
          // final cleanup even if a crash follows the catalog unlink itself.
          job = { ...job, phase: 'catalog' }; await save(job, budget, signal);
        }
        await pins.withGateway(budget, async check => {
          check(); await removeWindowCommitSourceCatalog(directory, scope, id, check); check();
          await rm(address, { force: true }); check(); await syncWindowDirectory(directory); check();
        }, signal);
        return { kind: 'collected' as const, sourceId: id };
      });
    },
  };
}
