import { link, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWindowFrame, encodeWindowFrame } from '@gugu/session-core/session-record/window-cache/frame';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { prepareWindowCommitDirectory } from './window-commit-directory';
import { snapshotWindowCommitReceipt, type WindowCommitReceipt } from './window-commit-receipt';
import { windowCommitSourceBinding } from './window-commit-source';

export function windowCommitCatalogPath(directory: string, scope: string, sourceId: string) {
  if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sourceId))
    throw new Error('Invalid source catalog address');
  return join(directory, 'source-versions', scope, `${sourceId}.version`);
}
const key = (scope: string, sourceId: string) => ({ ...windowCommitSourceBinding(scope, sourceId), kind: 'checkpoint' as const, cursor: 'source:catalog' });

/** The bounded receipt outlives SQLite's canonical-delete FK cascade. Its UUID
 * filename is an incremental GC discovery key, never an index of source bodies. */
export async function writeWindowCommitSourceCatalog(directory: string, input: WindowCommitReceipt) {
  const receipt = snapshotWindowCommitReceipt(input), scope = receipt.binding.scope, sourceId = receipt.sourceId;
  const path = windowCommitCatalogPath(directory, scope, sourceId), temporary = `${path}.tmp`;
  if (JSON.stringify(receipt.binding) !== JSON.stringify(windowCommitSourceBinding(scope, sourceId))) throw new Error('Source catalog binding mismatch');
  const packet = encodeWindowFrame(key(scope, sourceId), Buffer.from(JSON.stringify(receipt)));
  await prepareWindowCommitDirectory(directory, ['source-versions', scope]);
  // Callers hold the canonical writer tail for this source; a temporary left by
  // an interrupted earlier attempt is never published and must not block a retry.
  await rm(temporary, { force: true });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      let at = 0;
      while (at < packet.length) { const result = await file.write(packet, at, packet.length - at, at);
        if (!result.bytesWritten) throw new Error('Short source catalog write'); at += result.bytesWritten; }
      await file.sync();
    } finally { await file.close(); }
    await link(temporary, path); await rm(temporary); await syncWindowDirectory(join(directory, 'source-versions', scope));
  } finally { await rm(temporary, { force: true }); }
}

/** Exact write-set cleanup for the source-before intent; no directory listing. */
export async function removeWindowCommitSourceCatalog(directory: string, scope: string, sourceId: string, check?: () => void) {
  const path = windowCommitCatalogPath(directory, scope, sourceId);
  check?.(); await rm(`${path}.tmp`, { force: true }); check?.(); await rm(path, { force: true }); check?.();
  try { await syncWindowDirectory(join(directory, 'source-versions', scope)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  check?.();
}

export async function readWindowCommitSourceCatalog(directory: string, scope: string, sourceId: string, budget: WindowBudget, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const path = windowCommitCatalogPath(directory, scope, sourceId);
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'miss' as const, reason: 'not_found' as const }; throw error; }
  try {
    const before = await file.stat({ bigint: true }), frameKey = key(scope, sourceId);
    const maximum = encodeWindowFrame(frameKey, new Uint8Array(4096)).byteLength;
    if (!before.isFile() || before.size < 48n || before.size > BigInt(maximum)) throw new Error('Invalid source catalog size');
    const length = Number(before.size); let bytes: Uint8Array = new Uint8Array(0), used = 0, failed = false, failure: unknown;
    await budget.read('indexBytes', length, async () => {
      bytes = new Uint8Array(length);
      try {
        while (used < length) { signal?.throwIfAborted(); const result = await file.read(bytes, used, length - used, used);
          if (!result.bytesRead) break; used += result.bytesRead; }
      } catch (error) { failed = true; failure = error; }
      return used;
    });
    if (failed) throw failure; signal?.throwIfAborted();
    const after = await file.stat({ bigint: true }), named = await stat(path, { bigint: true });
    if (used !== length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      throw new Error('Source catalog changed during read');
    if (named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
      || named.mtimeNs !== before.mtimeNs || named.ctimeNs !== before.ctimeNs) throw new Error('Source catalog replaced during read');
    signal?.throwIfAborted();
    const decoded = decodeWindowFrame(frameKey, bytes); if (decoded.kind !== 'hit') throw new Error('Invalid source catalog frame');
    const receipt = snapshotWindowCommitReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes)) as WindowCommitReceipt);
    if (receipt.sourceId !== sourceId || JSON.stringify(receipt.binding) !== JSON.stringify(windowCommitSourceBinding(scope, sourceId)))
      throw new Error('Source catalog binding mismatch');
    return { kind: 'hit' as const, receipt };
  } finally { await file.close(); }
}
