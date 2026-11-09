import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { Connection } from '@gugu/session-wire/api';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { persistCommittedTurn } from '../sessions/session-turn-store';
import { createWindowCommitRuntime, type WindowCommitProjection } from './window-commit-runtime';
import type { WindowCommitReceipt } from './window-commit-receipt';
import type { WindowCommittedEvent } from './window-commit-tap';

type Producer = ((receipt: WindowCommitReceipt) => Promise<WindowCommitProjection>) & { flush?(sessionId?:string): Promise<void> };
type Runtime = ReturnType<typeof createWindowCommitRuntime>;
type Slot = { runtime: Runtime; producer?: { project: Producer }; enabled: boolean; storageFailed?: unknown; observe(event: WindowCommittedEvent): void };
let current: Slot | undefined;
const report = (message: string, error: unknown) => { try { log.warn(message, { error }); } catch { /* Diagnostics cannot interrupt the writer. */ } };
function slot(): Slot {
  if (current) return current;
  const value: Slot = { enabled: false, observe() {}, runtime: createWindowCommitRuntime({
    persist(event, capture) {
      const written = persistCommittedTurn({ ...event, windowCapture: capture });
      try { value.observe(event); } catch (error) { report('sessionWindow: commit observer failed', error); }
      return written;
    },
    capture(event, cursor, committed) {
      const directory = join(app.getPath('userData'), 'session-window-cache', 'committed');
      const scope = createHash('sha256').update(JSON.stringify([directory, event.sessionId])).digest('hex');
      const producer = value.producer;
      if (!producer) throw Object.assign(new Error('Commit projection is unavailable'), { code: 'live_projection_unavailable' });
      return { directory, scope, cursor, committed, project: producer.project };
    },
    project(receipt) {
      if (!value.producer) throw Object.assign(new Error('Commit projection is unavailable'), { code: 'live_projection_unavailable' });
      return value.producer.project(receipt);
    },
    flush(sessionId) { void value.producer?.project.flush?.(sessionId).catch(error => report('sessionWindow: owner projection flush failed',error)); },
    report: error => report('sessionWindow: committed history failed', error),
  }) }; current = value; return value;
}

/** Await in lazyWorker.onSpawned, before any start/resume can receive the worker. */
/** `prepare` runs before the committed-event source attaches. If it fails, no
 * window can reserve a capture; canonical persistence itself still proceeds. */
export async function connectWindowCommitHost(source: Parameters<Runtime['attach']>[0], observe: Slot['observe'], connection: Pick<Connection, 'onDisconnect'>,
  prepare?: () => Promise<void>) {
  const selected = slot(); selected.observe = observe;
  const releaseDisconnect = connection.onDisconnect(() => selected.runtime.invalidate());
  // Initialize before the awaited worker-start barrier, never before joining the
  // canonical writer queue where concurrent mkdir waits could reorder commits.
  const userData = app.getPath('userData'), cache = join(userData, 'session-window-cache'), directory = join(cache, 'committed');
  try {
    await mkdir(directory, { recursive: true });
    for (const path of [directory, cache, userData]) await syncWindowDirectory(path);
    await prepare?.();
    selected.storageFailed = undefined;
  } catch (error) {
    selected.storageFailed = error; selected.runtime.invalidateStore();
    report('sessionWindow: commit storage unavailable', error);
  }
  try { await selected.runtime.attach(source); }
  catch (error) {
    releaseDisconnect(); selected.runtime.invalidate(); selected.runtime.close();
    void selected.producer?.project.flush?.().catch(error => report('sessionWindow: final projection flush failed',error));
    if (current === selected) current = undefined;
    throw error;
  }
  return { invalidate: () => selected.runtime.invalidate(), close() {
    releaseDisconnect(); selected.runtime.invalidate(); selected.runtime.close();
    void selected.producer?.project.flush?.().catch(error => report('sessionWindow: final projection flush failed',error));
    if (current === selected) current = undefined;
  } };
}
/** The durable producer must exist before a route can reserve the new handoff. */
export function bindWindowCommitProjection(project: Producer): () => void {
  const selected = slot();
  if (selected.producer) throw new Error('A commit projection producer is already bound');
  const producer = { project }; selected.producer = producer; selected.enabled = true;
  return () => { if (selected.producer !== producer) return; selected.producer = undefined; selected.enabled = false; selected.runtime.invalidateStore();
    void producer.project.flush?.().catch(error => report('sessionWindow: projection release flush failed',error)); };
}
/** One main-owned production factory per host generation; no worker get/start. */
export function ensureWindowCommitProjection(factory: () => Producer): void {
  const selected = slot();
  if (selected.producer) return;
  selected.producer = { project: factory() }; selected.enabled = true;
}
export function reserveWindowCommitHost(...input: Parameters<Runtime['reserve']>) {
  const selected = slot();
  if (!selected.enabled || selected.storageFailed) throw Object.assign(new Error('Commit projection is unavailable'), { code: 'live_projection_unavailable' });
  return selected.runtime.reserve(...input);
}
