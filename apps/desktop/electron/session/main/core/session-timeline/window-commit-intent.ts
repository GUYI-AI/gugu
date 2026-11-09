import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { readWindowFrame, syncWindowDirectory, writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { assertWindowCommitSource, windowCommitSourceBinding, windowCommitSourcePath } from './window-commit-source';
import { createWindowCommitReceipts, type WindowReceiptDatabase } from './window-commit-receipt';
import { readWindowCommitSourceCatalog, removeWindowCommitSourceCatalog, writeWindowCommitSourceCatalog } from './window-commit-source-catalog';

type Scope = { directory: string; scope: string; sessionId: string };
type Intent = { version: 1; sourceId: string; sessionId: string; rowId: string; referenceId: string; storedSeq: number };
const key = (scope: string) => ({ scope, sourceLineage: scope, decoderVersion: 1, kind: 'head' as const, cursor: 'source:intent' });
export const windowCommitIntentBinding = windowCommitSourceBinding;
function validate(input: Scope, intent: Intent): void {
  if (!/^[a-f0-9]{64}$/.test(input.scope) || intent?.version !== 1 || intent.sessionId !== input.sessionId
    || !/^[a-f0-9-]{36}$/.test(intent.sourceId)
    || ![intent.sessionId, intent.rowId, intent.referenceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    || !Number.isSafeInteger(intent.storedSeq) || intent.storedSeq < 0) throw new Error('Invalid commit source intent');
}

/** Fixed per-session address, written before opening any raw source file. The
 * caller owns the existing canonical per-session writer tail. No directory scan. */
export async function beginWindowCommitIntent(input: Scope, intent: Intent): Promise<void> {
  validate(input, intent);
  await writeWindowFrame(input.directory, key(input.scope), Buffer.from(JSON.stringify({ version: 1,
    sourceId: intent.sourceId, sessionId: intent.sessionId, rowId: intent.rowId,
    referenceId: intent.referenceId, storedSeq: intent.storedSeq })));
}

/** Read one fixed intent without recovering, unlinking or traversing a source. */
export async function readWindowCommitIntent(input: Scope, budget: WindowBudget, signal?: AbortSignal): Promise<Intent | null> {
  signal?.throwIfAborted();
  const found = await readWindowFrame(input.directory, key(input.scope), budget);
  signal?.throwIfAborted();
  if (found.kind !== 'hit') {
    if (found.reason === 'not_found') return null;
    throw found.reason === 'io' ? found.error : new Error('Invalid commit source intent frame');
  }
  const intent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(found.bytes)) as Intent;
  validate(input, intent);
  return intent;
}

/** Point recovery shares the caller's budget. SQLite's atomic receipt decides
 * ownership; no canonical JSON, projection or source body is decoded. Call under
 * the canonical writer tail, including when opening a session after restart. */
export async function recoverWindowCommitIntent(connection: WindowReceiptDatabase, input: Scope,
  budget: WindowBudget, signal?: AbortSignal): Promise<'none' | 'retained' | 'removed'> {
  const intent = await readWindowCommitIntent(input, budget, signal);
  if (!intent) return 'none';
  const binding = windowCommitIntentBinding(input.scope, intent.sourceId);
  const receipt = createWindowCommitReceipts(connection).bySource(intent.sourceId);
  if (receipt) {
    if (receipt.sessionId !== intent.sessionId || receipt.rowId !== intent.rowId || receipt.referenceId !== intent.referenceId
      || receipt.storedSeq !== intent.storedSeq || JSON.stringify(receipt.binding) !== JSON.stringify(binding))
      throw new Error('Commit source intent receipt mismatch');
    await assertWindowCommitSource(input.directory, binding, receipt.source);
    const catalog = await readWindowCommitSourceCatalog(input.directory, input.scope, intent.sourceId, budget, signal);
    // A receipt committed by a build before source catalogs has none. The receipt
    // is exactly the catalog content, so migrate it instead of failing every
    // later canonical write in this session. A different catalog stays an error.
    if (catalog.kind === 'miss') await writeWindowCommitSourceCatalog(input.directory, receipt);
    else if (JSON.stringify(catalog.receipt) !== JSON.stringify(receipt)) throw new Error('Commit source catalog is not durable');
  } else {
    const source = windowCommitSourcePath(input.directory, binding);
    await rm(`${source}.${intent.sourceId}.tmp`, { force: true });
    await rm(source, { force: true });
    await removeWindowCommitSourceCatalog(input.directory, input.scope, intent.sourceId);
    // Make deletion durable before forgetting which exact files were owned.
    await syncWindowDirectory(input.directory);
  }
  signal?.throwIfAborted();
  await rm(join(input.directory, windowFrameName(key(input.scope))));
  await syncWindowDirectory(input.directory);
  return receipt ? 'retained' : 'removed';
}
