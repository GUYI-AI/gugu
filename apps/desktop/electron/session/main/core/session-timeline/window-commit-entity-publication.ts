import { setImmediate } from 'node:timers/promises';
import { readWindowFrame, writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget, WindowIoCounters } from '@gugu/session-core/session-record/window-cache/types';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { advanceCommitContainerIndex } from './window-commit-container-index';
import { advanceCommitEntityFields, commitEntityIndex, commitEntityPublicationId, commitEntityPublicationKey, createCommitEntityState,
  type CommitEntityPosition, type CommitEntityPublication } from './window-commit-entity';
import { openCommitBodySlot, advanceCommitBodySlot, readCommitBodySlot } from './window-commit-slot';
import { readWindowCommitProjection } from './window-commit-projection';
import { assertWindowCommitSource } from './window-commit-source';

/** Background producer, one admitted I/O budget then yield per step. It keeps
 * one entity plus at most three slot references, never a whole turn/item list.
 * Metrics/diagnostic exceptions cannot change persistence or publication. */
export async function publishCommitEntity(input: { directory: string; receipts: Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>;
  receipt: WindowCommitReceipt; rootBuildId: string; position: CommitEntityPosition;
  observed?(io: Readonly<WindowIoCounters>): void; report?(error: unknown): void }, signal?: AbortSignal) {
  const receipt = snapshotWindowCommitReceipt(input.receipt), directory = input.directory, rootBuildId = input.rootBuildId;
  const receipts = input.receipts, position = input.position, id = commitEntityPublicationId(position), index = commitEntityIndex(position);
  const committed = () => {
    const stored = receipts.bySource(receipt.sourceId);
    if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(receipt)
      || position.sourceId !== receipt.sourceId || position.rowId !== receipt.rowId) throw new Error('Entity needs its actual committed source');
  };
  committed(); signal?.throwIfAborted();
  async function step<T>(read: (budget: WindowBudget) => Promise<T>) {
    const budget = createWindowBudget();
    try { return await read(budget); }
    finally { try { input.observed?.(budget.counters); } catch (error) { try { input.report?.(error); } catch { /* diagnostics only */ } } }
  }
  const root = await step(budget => readWindowCommitProjection({ directory, receipts, receipt, buildId: rootBuildId }, budget, signal));
  const rebuild = () => ({ kind: 'rebuild' as const, anchor: { sourceId: receipt.sourceId, ...position.range } });
  if (root.kind !== 'projection' || root.root.turnId !== position.turnId) return rebuild();
  for (;;) {
    const result = await step(budget => advanceCommitContainerIndex({ directory, binding: receipt.binding, source: receipt.source, index }, budget, signal));
    if (result.kind === 'rebuild') return rebuild(); if (result.kind === 'complete') break;
    await setImmediate(undefined, { signal });
  }
  let state = createCommitEntityState(position);
  for (;;) {
    const result = await step(budget => advanceCommitEntityFields(position, state, budget, signal));
    if (result.kind !== 'progress' && result.kind !== 'complete') return rebuild();
    state = result.state;
    if (result.kind === 'complete') {
      for (const field of result.facts.slots) {
        const slot = openCommitBodySlot(directory, receipts, receipt, result.facts, field.field, id);
        let first = await step(budget => readCommitBodySlot(slot, 0, budget, signal));
        if (first.kind !== 'body') {
          const advanced = await step(budget => advanceCommitBodySlot(slot, budget, signal)); if (advanced.kind === 'rebuild') return rebuild();
          first = await step(budget => readCommitBodySlot(slot, 0, budget, signal));
        }
        if (first.kind !== 'body') return rebuild();
        await setImmediate(undefined, { signal });
      }
      break;
    }
    await setImmediate(undefined, { signal });
  }
  const value: CommitEntityPublication = { version: 1, rootBuildId, position, state }, data = Buffer.from(JSON.stringify(value));
  if (data.length > 8192) throw new Error('Entity publication exceeds 8 KiB');
  const key = commitEntityPublicationKey(receipt, id);
  signal?.throwIfAborted(); committed(); await assertWindowCommitSource(directory, receipt.binding, receipt.source);
  await step(async budget => {
    try { await writeWindowFrame(directory, key, data); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const previous = await readWindowFrame(directory, key, budget);
      if (previous.kind === 'miss' && previous.reason === 'io') throw previous.error;
      if (previous.kind !== 'hit' || !Buffer.from(previous.bytes).equals(data)) throw new Error('Conflicting immutable entity publication');
    }
  });
  await assertWindowCommitSource(directory, receipt.binding, receipt.source); committed(); signal?.throwIfAborted();
  return { kind: 'published' as const, entityId: id };
}
