import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import { sessionDatabaseConnection } from '@main/db/client';
import { log } from '@main/lib/logger';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { windowProjectionOpenSchema, windowProjectionPageSchema, windowProjectionFieldPageSchema,
  type WindowProjectionReadRequest, type WindowProjectionBodyReadRequest,
  type WindowProjectionReadValue, type WindowProjectionFieldPage } from '@gugu/session-wire/session-window-projection';
import type { WindowLiveResult } from '@gugu/session-wire/session-window-live';
import { withStoredTurns } from '../sessions/session-turn-store';
import { recoverWindowCommitIntent } from './window-commit-intent';
import { createWindowProjectionHost, type WindowProjectionOwner } from './window-projection-host';

let current: ReturnType<typeof createWindowProjectionHost> | undefined;
const directory = () => join(app.getPath('userData'), 'session-window-cache', 'committed');
function report(error: unknown) { try { log.warn('sessionWindow: projection owner cleanup failed', { error }); } catch { /* diagnostics only */ } }
function host() { return current ??= createWindowProjectionHost({ connection: sessionDatabaseConnection(), directory: directory(), report }); }
function failed(error: unknown): { ok: false; error: { code: string; message: string } } {
  const value = error as { code?: unknown; name?: string };
  const code = value.name === 'AbortError' ? 'cancelled'
    : typeof value.code === 'string' && ['needs_location', 'unsubscribed', 'invalid_subscription', 'capacity', 'closed', 'pending'].includes(value.code)
      ? value.code : 'needs_location';
  // Native filesystem and SQLite messages can contain private host paths.
  return { ok: false, error: { code, message: code === 'cancelled' ? 'Projection request cancelled' : 'The requested projection is unavailable' } };
}
// Keep final proofs out of wire values. The exact result object carries its
// host-only proof to the controller's last synchronous return boundary.
const replies = new WeakMap<object, () => void>();
function completed<T>(value: T, verify: () => void): WindowLiveResult<T> {
  verify(); const result = { ok: true as const, value }; replies.set(result, verify); return result;
}
export function finishWindowProjectionReply<T>(result: WindowLiveResult<T>): WindowLiveResult<T> {
  if (!result.ok) return result;
  try {
    const verify = replies.get(result);
    if (!verify) throw new Error('Projection reply has no host proof');
    verify(); return result;
  } catch (error) { return failed(error); }
}
/** Clear an earlier development cache layout under the projection gateway
 * before the committed-event writer attaches. */
export async function prepareWindowCommitStorage(): Promise<void> {
  const selected = host(); await selected.prepared; scheduleCollection(selected);
}
// Background reclamation after the layout is current: first pass soon after
// start, then periodically. Each pass is bounded; failures are reported only.
const FIRST_PASS_MS = 30_000, PASS_INTERVAL_MS = 5 * 60_000;
let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleCollection(selected: ReturnType<typeof host>, delay = FIRST_PASS_MS) {
  if (timer) return;
  timer = setTimeout(() => {
    void selected.collect().catch(error => { try { log.warn('sessionWindow: commit source collection failed', { error }); } catch { /* diagnostics only */ } })
      .finally(() => { timer = undefined; if (current === selected) scheduleCollection(selected, PASS_INTERVAL_MS); });
  }, delay);
  timer.unref?.();
}
export function closeWindowProjectionOwner(identity: object) {
  if (current) void current.close(identity).catch(() => {}); // The host retains and reports failed cleanup.
}
export async function readWindowProjection(ownerOf: () => WindowProjectionOwner, input: WindowProjectionReadRequest): Promise<WindowLiveResult<WindowProjectionReadValue>> {
  try {
    const owner = ownerOf(); owner.assertCurrent();
    const selected = host(), budget = createWindowBudget(); let verify = () => {};
    // Pick scalar requests before the first await; no caller-owned locator stays live.
    const request = input.kind === 'open' ? { kind: input.kind, position: { ...input.position } }
      : input.kind === 'page' ? { kind: input.kind, cursor: input.cursor } : { kind: input.kind, lease: input.lease };
    const result = await selected.run(owner, budget, async (adapter, identity, io) => {
      if (request.kind === 'open') {
        const path = directory(), scope = createHash('sha256').update(JSON.stringify([path, owner.sessionId])).digest('hex');
        await withStoredTurns(owner.sessionId, async () => {
          selected.assertCurrent(owner); owner.signal?.throwIfAborted();
          await recoverWindowCommitIntent(sessionDatabaseConnection(), { directory: path, scope, sessionId: owner.sessionId }, io, owner.signal);
        });
        const value = await adapter.open(identity, request.position, io, owner.signal);
        verify = () => adapter.assertLease(identity, value.lease); return value;
      }
      if (request.kind === 'page') {
        const value = await adapter.readPage(identity, request.cursor, io, owner.signal);
        verify = () => adapter.assertHandle(identity, request.cursor); return value;
      }
      await adapter.release(identity, request.lease, io, owner.signal);
    });
    const value = request.kind === 'open' ? windowProjectionOpenSchema.parse(result)
      : request.kind === 'page' ? windowProjectionPageSchema.parse(result) : undefined;
    if (request.kind === 'release' && result !== undefined) throw new Error('Projection release returned an unexpected value');
    // The public export has its own synchronous final gate after its last await.
    return completed(value, () => { selected.assertCurrent(owner); owner.signal?.throwIfAborted(); verify(); });
  } catch (error) { return failed(error); }
}
export async function readWindowProjectionBody(ownerOf: () => WindowProjectionOwner, input: WindowProjectionBodyReadRequest): Promise<WindowLiveResult<WindowProjectionFieldPage>> {
  try {
    const owner = ownerOf(); owner.assertCurrent();
    const selected = host(), handle = input.handle; let verify = () => {};
    const result = await selected.run(owner, createWindowBudget(), async (adapter, identity, budget) => {
      const value = await adapter.readField(identity, handle, budget, owner.signal);
      verify = () => adapter.assertHandle(identity, handle); return value;
    });
    const value = windowProjectionFieldPageSchema.parse(result);
    return completed(value, () => { selected.assertCurrent(owner); owner.signal?.throwIfAborted(); verify(); });
  } catch (error) { return failed(error); }
}
