import { createHash } from 'node:crypto';
import { mkdir, open, rename, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SLOT = 1024;
const HEADER = 40;
const MAX_BATCH = 24;

/** Structurally compatible with the shared request budget; never create one per lookup. */
export interface IdentityBudget {
  read(kind: 'indexBytes', requested: number, operation: () => Promise<number>): Promise<number>;
  charge(kind: 'examinedRecords', amount: number): void;
}
export type IdentityValue = { canonicalId: string; revision: string; projectionRef: string };
export type IdentityLookup = { kind: 'found'; value: IdentityValue } | { kind: 'absent' };
export type IdentityWrite = { scope: string; lineage: string; key: string; value: IdentityValue };
type Row = IdentityValue & { binding: string; commitSeq: number };
type Space = 'receipt' | 'identity';

export class IdentityIndexError extends Error {
  constructor(readonly code: 'corrupt' | 'conflict' | 'busy' | 'invalid', detail: string) {
    super(`Identity index ${code}: ${detail}`);
    this.name = 'IdentityIndexError';
  }
}

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new IdentityIndexError('invalid', 'commit fence');
}
function bounded(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 256) {
    throw new IdentityIndexError('invalid', 'bounded scalar required');
  }
}
function digest(value: string | Uint8Array): Buffer {
  return createHash('sha256').update(value).digest();
}
function binding(space: Space, scope: string, lineage: string, key: string): string {
  [scope, lineage, key].forEach(bounded);
  return digest(JSON.stringify([1, space, scope, lineage, key])).toString('hex');
}
function encode(row: Row): Buffer {
  [row.canonicalId, row.revision, row.projectionRef].forEach(bounded);
  // Each scalar was bounded before serialization: even escape expansion is constant-sized.
  const payload = Buffer.from(JSON.stringify({ binding: row.binding, commitSeq: row.commitSeq,
    canonicalId: row.canonicalId, revision: row.revision, projectionRef: row.projectionRef }));
  if (payload.length > SLOT - HEADER) throw new IdentityIndexError('invalid', 'entry exceeds fixed slot');
  const bytes = Buffer.alloc(SLOT);
  bytes.write('GID1');
  bytes.writeUInt32BE(payload.length, 4);
  digest(payload).copy(bytes, 8);
  payload.copy(bytes, HEADER);
  return bytes;
}
function decode(bytes: Buffer, expected: string): Row {
  const size = bytes.readUInt32BE(4);
  if (bytes.toString('ascii', 0, 4) !== 'GID1' || size > SLOT - HEADER) {
    throw new IdentityIndexError('corrupt', 'slot header');
  }
  const payload = bytes.subarray(HEADER, HEADER + size);
  if (!digest(payload).equals(bytes.subarray(8, HEADER))) throw new IdentityIndexError('corrupt', 'checksum');
  let row: Row;
  try { row = JSON.parse(payload.toString()) as Row; }
  catch { throw new IdentityIndexError('corrupt', 'JSON'); }
  if (row?.binding !== expected || !Number.isSafeInteger(row.commitSeq) || row.commitSeq < 1
    || [row.canonicalId, row.revision, row.projectionRef].some(value => typeof value !== 'string' || !value.length || value.length > 256)) {
    throw new IdentityIndexError('corrupt', 'ownership or schema');
  }
  return row;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/**
 * Direct hash addressing, then fixed-slot commit keyset search. No directory enumeration,
 * key hydration or history-sized cache. One exclusive producer owns this directory;
 * readers may pin any published head. The caller supplies an existing durable parent,
 * and publishes its head only after this returns. Commit numbers must be contiguous;
 * retry a crashed segment with exactly its original writes, recovered from A's frames.
 */
export class TailIdentityStore {
  private writing = false;
  constructor(private readonly root: string) {}

  private path(hash: string): string { return join(this.root, hash.slice(0, 2), `${hash}.gidx`); }

  private async read(file: FileHandle, position: number, length: number, budget: IdentityBudget): Promise<Buffer> {
    const bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const read = await budget.read('indexBytes', length - used,
        async () => (await file.read(bytes, used, length - used, position + used)).bytesRead);
      if (!read) throw new IdentityIndexError('corrupt', 'short slot');
      used += read;
    }
    return bytes;
  }
  private async slot(file: FileHandle, hash: string, index: number, budget: IdentityBudget): Promise<Row> {
    const bytes = await this.read(file, index * SLOT, SLOT, budget);
    budget.charge('examinedRecords', 1);
    return decode(bytes, hash);
  }

  private async fence(hash: string, budget: IdentityBudget): Promise<number | null> {
    let file: FileHandle;
    try { file = await open(`${this.path(hash)}.fence`, 'r'); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const bytes = await this.read(file, 0, 48, budget), length = bytes.readDoubleBE(4);
      if ((await file.stat()).size !== 48 || bytes.toString('ascii', 0, 4) !== 'GFD1'
        || !Number.isSafeInteger(length) || length < 0 || length % SLOT
        || !digest(`${hash}:${length}`).equals(bytes.subarray(12, 44))) throw new IdentityIndexError('corrupt', 'durable fence');
      return length;
    } finally { await file.close(); }
  }
  private async publishFence(hash: string, length: number): Promise<void> {
    const bytes = Buffer.alloc(48); bytes.write('GFD1'); bytes.writeDoubleBE(length, 4);
    digest(`${hash}:${length}`).copy(bytes, 12);
    const path = `${this.path(hash)}.fence`, pending = await open(`${path}.pending`, 'w');
    try { await pending.writeFile(bytes); await pending.sync(); } finally { await pending.close(); }
    await rename(`${path}.pending`, path);
  }
  private async find(file: FileHandle, hash: string, atCommit: number, budget: IdentityBudget): Promise<{ row: Row | null; count: number; tail: Row | null }> {
    const durable = await this.fence(hash, budget);
    const size = (await file.stat()).size;
    if (!Number.isSafeInteger(size)) throw new IdentityIndexError('corrupt', 'file size');
    if (durable === null && size >= SLOT && (await this.slot(file, hash, 0, budget)).commitSeq <= atCommit) {
      throw new IdentityIndexError('corrupt', 'missing committed fence');
    }
    if (durable !== null && size < durable) throw new IdentityIndexError('corrupt', 'committed range truncated');
    const count = (durable ?? 0) / SLOT;
    if (!count) return { row: null, count: 0, tail: null };
    const tail = await this.slot(file, hash, count - 1, budget);
    if (tail.commitSeq <= atCommit) return { row: tail, count, tail };
    // Exact interrupted-next-commit retries need two probes, regardless of revision count.
    if (count > 1) {
      const previous = await this.slot(file, hash, count - 2, budget);
      if (previous.commitSeq <= atCommit) return { row: previous, count: count - 1, tail };
    }
    let low = 0, high = count - 1;
    let row: Row | null = null;
    for (let probes = 0; low < high && probes < 53; probes++) {
      const mid = low + Math.floor((high - low) / 2);
      const candidate = await this.slot(file, hash, mid, budget);
      if (candidate.commitSeq <= atCommit) { row = candidate; low = mid + 1; }
      else high = mid;
    }
    if (low < high) throw new IdentityIndexError('corrupt', 'probe ceiling');
    return { row, count: low, tail };
  }

  private async lookup(space: Space, scope: string, lineage: string, key: string, atCommit: number, budget: IdentityBudget): Promise<IdentityLookup> {
    integer(atCommit);
    const hash = binding(space, scope, lineage, key);
    let file: FileHandle;
    try { file = await open(this.path(hash), 'r'); }
    catch (error) {
      if (!missing(error)) throw error;
      if (await this.fence(hash, budget) !== null) throw new IdentityIndexError('corrupt', 'committed data missing');
      return { kind: 'absent' };
    }
    try {
      const { row } = await this.find(file, hash, atCommit, budget);
      return row ? { kind: 'found', value: { canonicalId: row.canonicalId, revision: row.revision, projectionRef: row.projectionRef } } : { kind: 'absent' };
    } finally { await file.close(); }
  }

  lookupReceipt(scope: string, lineage: string, key: string, atCommit: number, budget: IdentityBudget): Promise<IdentityLookup> {
    return this.lookup('receipt', scope, lineage, key, atCommit, budget);
  }
  lookupIdentity(scope: string, branch: string, nativeKey: string, atCommit: number, budget: IdentityBudget): Promise<IdentityLookup> {
    return this.lookup('identity', scope, branch, nativeKey, atCommit, budget);
  }

  /** publishedCommit authorizes discarding only invisible crash leftovers, never published rows. */
  async commitSegment(commitSeq: number, publishedCommit: number, receipts: readonly IdentityWrite[], aliases: readonly IdentityWrite[], budget: IdentityBudget): Promise<void> {
    integer(commitSeq); integer(publishedCommit);
    if (commitSeq !== publishedCommit + 1 || receipts.length + aliases.length > MAX_BATCH) throw new IdentityIndexError('invalid', 'segment size or fence');
    if (this.writing) throw new IdentityIndexError('busy', 'producer must apply backpressure');
    this.writing = true;
    try {
      const staged = [...receipts.map(write => ({ space: 'receipt' as const, write })), ...aliases.map(write => ({ space: 'identity' as const, write }))]
        .map(({ space, write }) => {
          const hash = binding(space, write.scope, write.lineage, write.key);
          return { space, hash, bytes: encode({ ...write.value, binding: hash, commitSeq }) };
        });
      if (new Set(staged.map(entry => entry.hash)).size !== staged.length) throw new IdentityIndexError('invalid', 'duplicate segment key');
      staged.sort((a, b) => a.hash.localeCompare(b.hash));
      await mkdir(this.root, { recursive: false }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const parent = await open(dirname(this.root), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      const seal = createHash('sha256');
      staged.forEach(entry => seal.update(entry.bytes));
      const expected = seal.digest();
      const intentPath = join(this.root, `${commitSeq}.intent`);
      let intent: FileHandle;
      try { intent = await open(intentPath, 'r'); }
      catch (error) {
        if (!missing(error)) throw error;
        const pending = await open(`${intentPath}.pending`, 'w');
        try { await pending.writeFile(expected); await pending.sync(); } finally { await pending.close(); }
        await rename(`${intentPath}.pending`, intentPath);
        const dir = await open(this.root, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
        intent = await open(intentPath, 'r');
      }
      try {
        if ((await intent.stat()).size !== 32 || !(await this.read(intent, 0, 32, budget)).equals(expected)) {
          throw new IdentityIndexError('conflict', 'crash retry changed segment');
        }
      } finally { await intent.close(); }
      for (const entry of staged) {
        const directory = join(this.root, entry.hash.slice(0, 2));
        await mkdir(directory, { recursive: true });
        let file: FileHandle;
        try { file = await open(this.path(entry.hash), 'r+'); }
        catch (error) { if (!missing(error)) throw error; file = await open(this.path(entry.hash), 'wx+'); }
        try {
          const size = (await file.stat()).size, partial = size % SLOT;
          if (partial) {
            const bytes = await this.read(file, size - partial, partial, budget);
            if (!bytes.equals(entry.bytes.subarray(0, partial))) throw new IdentityIndexError('corrupt', 'torn retry differs');
            await file.truncate(size - partial);
          }
          const prior = await this.find(file, entry.hash, publishedCommit, budget);
          const next = decode(entry.bytes, entry.hash);
          if (prior.row && (prior.row.canonicalId !== next.canonicalId
            || (entry.space === 'receipt' && (prior.row.revision !== next.revision || prior.row.projectionRef !== next.projectionRef)))) {
            throw new IdentityIndexError('conflict', 'canonical identity or receipt differs');
          }
          const alreadyDurable = prior.tail?.commitSeq === commitSeq;
          if (alreadyDurable && !encode(prior.tail!).equals(entry.bytes)) throw new IdentityIndexError('conflict', 'durable retry differs');
          if (!alreadyDurable) await file.truncate(prior.count * SLOT);
          if (!alreadyDurable && (!prior.row || entry.space === 'identity')) {
            let written = 0;
            while (written < SLOT) {
              const result = await file.write(entry.bytes, written, SLOT - written, prior.count * SLOT + written);
              if (!result.bytesWritten) throw new IdentityIndexError('corrupt', 'short write');
              written += result.bytesWritten;
            }
          }
          await file.sync();
          await this.publishFence(entry.hash, (await file.stat()).size);
        } finally { await file.close(); }
        const dir = await open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
      const root = await open(this.root, 'r');
      try { await root.sync(); } finally { await root.close(); }
    } finally { this.writing = false; }
  }
}
