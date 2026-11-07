import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readWindowFrame, syncWindowDirectory, writeWindowFrame } from './disk-frame.ts';
import { windowFrameName, type WindowFrameKey } from './frame.ts';
import type { PreparedSegment, SegmentWrites, TailCommitIo } from './append-store';
import type { SegmentRef, TailHead, WindowBudget, WindowByteSource } from './types';

export class TailCacheReadError extends Error {
  constructor(readonly reason: string) { super(`Tail cache read: ${reason}`); this.name = 'TailCacheReadError'; }
}

/** The host supplies a durable, publication-epoch namespace and its single identity writer. */
export function createTailDiskIo(input: {
  directory: string; binding: Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'>;
  source: WindowByteSource; sourceInstance: string; initialHead?: TailHead;
  commitIdentity: TailCommitIo['commitIdentity'];
}): TailCommitIo {
  const key = (kind: WindowFrameKey['kind'], cursor: string): WindowFrameKey => ({ ...input.binding, kind, cursor });
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  async function payload(kind: WindowFrameKey['kind'], cursor: string, budget: WindowBudget) {
    const result = await readWindowFrame(input.directory, key(kind, cursor), budget);
    if (result.kind === 'miss') {
      if (result.reason === 'io') throw result.error;
      throw new TailCacheReadError(result.reason);
    }
    return result.bytes;
  }
  async function root<T>(cursor: string, budget: WindowBudget): Promise<T> {
    const bytes = await payload('head', cursor, budget);
    budget.charge('decodedBytes', bytes.length);
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as T; }
    catch { throw new TailCacheReadError('format'); }
  }
  async function persistRoot(cursor: string, value: unknown) {
    await writeWindowFrame(input.directory, key('head', cursor), Buffer.from(JSON.stringify(value)));
  }
  return {
    async readHead(budget) {
      try { return await root<TailHead>('current', budget); }
      catch (error) {
        // Only an explicitly fresh namespace may bootstrap; corrupt/old roots are never a fresh hit.
        if (error instanceof TailCacheReadError && error.reason === 'not_found' && input.initialHead) return input.initialHead;
        throw error;
      }
    },
    async readPending(budget) {
      try { return await root<PreparedSegment>('pending', budget); }
      catch (error) { if (error instanceof TailCacheReadError && error.reason === 'not_found') return null; throw error; }
    },
    async readWrites(ref: SegmentRef, budget): Promise<SegmentWrites> {
      if (ref.length > 16_000) throw new TailCacheReadError('format');
      const bytes = await payload('checkpoint', ref.id, budget), selected = bytes.subarray(ref.offset, ref.offset + ref.length);
      if (selected.length !== ref.length || hash(selected) !== ref.digest) throw new TailCacheReadError('checksum');
      budget.charge('decodedBytes', selected.length);
      try { return JSON.parse(Buffer.from(selected).toString('utf8')) as SegmentWrites; }
      catch { throw new TailCacheReadError('format'); }
    },
    async persistFrame(kind, bytes) {
      const id = `${kind}:${randomUUID()}`;
      await writeWindowFrame(input.directory, key(kind, id), bytes);
      return { id, offset: 0, length: bytes.length, digest: hash(bytes) };
    },
    persistPending: pending => persistRoot('pending', pending),
    async validateSourceFence(head, budget) {
      const before = await input.source.snapshot(), fence = head.sourceFence;
      if (before.sourceInstance !== input.sourceInstance || before.size < fence.end || fence.end - fence.start > 4096) return false;
      let bytes: Uint8Array = new Uint8Array(0), used = 0, failed = false, failure: unknown;
      await budget.read('sourceBytes', fence.end - fence.start, async () => {
        bytes = new Uint8Array(fence.end - fence.start);
        try {
          while (used < bytes.length) {
            const count = await input.source.read(bytes, used, bytes.length - used, fence.start + used);
            if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - used) throw new Error('Invalid source read length');
            if (!count) break; used += count;
          }
        } catch (error) { failed = true; failure = error; }
        return used;
      });
      if (failed) throw failure;
      const after = await input.source.snapshot();
      return used === bytes.length && after.sourceInstance === before.sourceInstance && after.size >= fence.end && hash(bytes) === fence.digest;
    },
    commitIdentity: input.commitIdentity,
    publishHead: head => persistRoot('current', head),
    async clearPending() {
      await rm(join(input.directory, windowFrameName(key('head', 'pending'))), { force: true });
      await syncWindowDirectory(input.directory);
    },
  };
}
