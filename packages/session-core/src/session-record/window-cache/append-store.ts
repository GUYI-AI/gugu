import type { SegmentRef, SourceRange, TailHead, TailSegment, WindowBudget } from './types';

export type IdentityWrite = { scope: string; lineage: string; key: string;
  value: { canonicalId: string; revision: string; projectionRef: string } };
export type SegmentWrites = { receipts: IdentityWrite[]; aliases: IdentityWrite[] };
export type PreparedSegment = { version: 1; previousCommit: number; head: TailHead; writes: SegmentRef };

/** Every persist operation returns only after file and namespace durability barriers. */
export interface TailCommitIo {
  readHead(budget: WindowBudget): Promise<TailHead>;
  readPending(budget: WindowBudget): Promise<PreparedSegment | null>;
  readWrites(ref: SegmentRef, budget: WindowBudget): Promise<SegmentWrites>;
  persistFrame(kind: 'projection' | 'checkpoint' | 'segment', bytes: Uint8Array): Promise<SegmentRef>;
  persistPending(pending: PreparedSegment): Promise<void>;
  validateSourceFence(head: TailHead, budget: WindowBudget): Promise<boolean>;
  commitIdentity(seq: number, published: number, receipts: IdentityWrite[], aliases: IdentityWrite[], budget: WindowBudget): Promise<void>;
  publishHead(head: TailHead): Promise<void>;
  clearPending(): Promise<void>;
}

function checkedRef(ref: SegmentRef): SegmentRef {
  if (!ref || typeof ref.id !== 'string' || typeof ref.digest !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.offset) || ref.offset < 0 || !Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > 64 * 1024 || !Number.isSafeInteger(ref.offset + ref.length))
    throw new Error('Invalid segment reference');
  return { id: ref.id, offset: ref.offset, length: ref.length, digest: ref.digest };
}
function checkedHead(head: TailHead): TailHead {
  const fence = head.sourceFence;
  if (head.format !== 'gugu.desktop-tail/1' || typeof head.scope !== 'string' || typeof head.sourceLineage !== 'string' || typeof fence.digest !== 'string' || !/^[a-f0-9]{64}$/.test(head.scope) || !/^[a-f0-9]{64}$/.test(head.sourceLineage) ||
    ![head.commitSeq, head.sourceEnd, fence.start, fence.end, head.decoderVersion].every(value => Number.isSafeInteger(value) && value >= 0) ||
    head.decoderVersion < 1 || (head.commitSeq === 0) !== (head.tail === null) || fence.start > fence.end || fence.end !== head.sourceEnd || fence.end - fence.start > 4096 || !/^[a-f0-9]{64}$/.test(fence.digest))
    throw new Error('Invalid bounded head');
  return { format: head.format, scope: head.scope, sourceLineage: head.sourceLineage, commitSeq: head.commitSeq,
    sourceEnd: head.sourceEnd, decoderVersion: head.decoderVersion, tail: head.tail ? checkedRef(head.tail) : null,
    sourceFence: { start: fence.start, end: fence.end, digest: fence.digest } };
}

function checkedWrites(writes: SegmentWrites): Uint8Array {
  if (writes.receipts.length + writes.aliases.length > 16) throw new Error('Segment write batch exceeds 16 entries');
  const encoded: string[] = [];
  let encodedBytes = 32;
  for (const write of [...writes.receipts, ...writes.aliases]) {
    const values = [write.scope, write.lineage, write.key, write.value.canonicalId, write.value.revision, write.value.projectionRef];
    if (values.some(value => typeof value !== 'string' || value.length === 0 || value.length > 256)) throw new Error('Invalid segment write scalar');
    // Encode only validated scalar fields, never caller-owned nested objects or extra properties.
    const entry = JSON.stringify({ scope: write.scope, lineage: write.lineage, key: write.key, value: {
      canonicalId: write.value.canonicalId, revision: write.value.revision, projectionRef: write.value.projectionRef } });
    encodedBytes += Buffer.byteLength(entry) + 1;
    if (encodedBytes > 16_000) throw new Error('Segment write set exceeds recovery budget');
    encoded.push(entry);
  }
  const split = writes.receipts.length;
  const text = `{"receipts":[${encoded.slice(0, split).join(',')}],"aliases":[${encoded.slice(split).join(',')}]}`;
  if (Buffer.byteLength(text) > 16_000) throw new Error('Segment write set exceeds recovery budget');
  return Buffer.from(text);
}

/** Single owner per namespace; the host must not instantiate a second concurrent writer. */
export function createTailCommitter(io: TailCommitIo) {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run); queue = result.catch(() => undefined); return result;
  };
  async function commit(pending: PreparedSegment, budget: WindowBudget): Promise<TailHead> {
    if (pending.version !== 1 || !Number.isSafeInteger(pending.previousCommit) || pending.previousCommit < 0) throw new Error('Invalid pending intent');
    pending = { version: 1, previousCommit: pending.previousCommit, head: checkedHead(pending.head), writes: checkedRef(pending.writes) };
    const current = checkedHead(await io.readHead(budget));
    if (current.commitSeq === pending.head.commitSeq) {
      if (JSON.stringify(current) !== JSON.stringify(pending.head)) throw new Error('Conflicting published segment');
      await io.clearPending(); return current;
    }
    if (current.commitSeq !== pending.previousCommit || pending.head.commitSeq !== current.commitSeq + 1 ||
      current.scope !== pending.head.scope || current.sourceLineage !== pending.head.sourceLineage) throw new Error('Segment commit fence conflict');
    const durable = await io.readPending(budget);
    if (!durable || JSON.stringify({ version: durable.version, previousCommit: durable.previousCommit,
      head: checkedHead(durable.head), writes: checkedRef(durable.writes) }) !== JSON.stringify(pending)) throw new Error('Pending intent was changed');
    if (!await io.validateSourceFence(pending.head, budget)) throw new Error('Segment source fence changed');
    const writes = await io.readWrites(pending.writes, budget);
    checkedWrites(writes);
    await io.commitIdentity(pending.head.commitSeq, current.commitSeq, writes.receipts, writes.aliases, budget);
    await io.publishHead(pending.head);
    await io.clearPending();
    return pending.head;
  }
  return {
    prepareSegment(input: { previous: TailHead; sourceRange: SourceRange; sourceFence: TailHead['sourceFence'];
      projection: Uint8Array; decoderCheckpoint: Uint8Array; writes: SegmentWrites; budget: WindowBudget }): Promise<PreparedSegment> {
      return serialized(async () => {
        if (await io.readPending(input.budget)) throw new Error('Recover the pending segment before consuming new input');
        const previous = checkedHead(input.previous), { sourceRange, sourceFence } = input;
        if (JSON.stringify(checkedHead(await io.readHead(input.budget))) !== JSON.stringify(previous)) throw new Error('Segment prepare fence conflict');
        if (!Number.isSafeInteger(previous.commitSeq + 1) || input.projection.length > 60 * 1024 || input.decoderCheckpoint.length > 60 * 1024 ||
          ![sourceRange.start, sourceRange.end, sourceFence.start, sourceFence.end].every(value => Number.isSafeInteger(value) && value >= 0) ||
          sourceRange.start > sourceRange.end || sourceRange.end < previous.sourceEnd || sourceFence.start > sourceFence.end ||
          sourceFence.end !== sourceRange.end || sourceFence.end - sourceFence.start > 4096 || !/^[a-f0-9]{64}$/.test(sourceFence.digest))
          throw new Error('Invalid bounded segment');
        const encodedWrites = checkedWrites(input.writes);
        const projection = checkedRef(await io.persistFrame('projection', input.projection));
        const decoderCheckpoint = checkedRef(await io.persistFrame('checkpoint', input.decoderCheckpoint));
        const writes = checkedRef(await io.persistFrame('checkpoint', encodedWrites));
        const commitSeq = previous.commitSeq + 1;
        const segment: TailSegment = { version: 1, scope: previous.scope, sourceLineage: previous.sourceLineage,
          commitSeq, previous: previous.tail, sourceRange: { start: sourceRange.start, end: sourceRange.end }, projection, decoderCheckpoint, dedupCommit: commitSeq, complete: true };
        const tail = checkedRef(await io.persistFrame('segment', Buffer.from(JSON.stringify({ ...segment, intentWrites: writes }))));
        const pending: PreparedSegment = { version: 1, previousCommit: previous.commitSeq, writes,
          head: { ...previous, commitSeq, tail, sourceEnd: sourceRange.end,
            sourceFence: { start: sourceFence.start, end: sourceFence.end, digest: sourceFence.digest } } };
        await io.persistPending(pending);
        return pending;
      });
    },
    commitPreparedSegment: (pending: PreparedSegment, budget: WindowBudget) => serialized(() => commit(pending, budget)),
    recoverPending: (budget: WindowBudget) => serialized(async () => {
      const pending = await io.readPending(budget);
      return pending ? commit(pending, budget) : null;
    }),
  };
}
