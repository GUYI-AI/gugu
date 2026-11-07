import { expect, it } from 'vitest';
import { createTailCommitter, type PreparedSegment, type SegmentWrites, type TailCommitIo } from './append-store';
import { createWindowBudget } from './read-budget';
import type { SegmentRef, TailHead } from './types';

const head = (): TailHead => ({ format: 'gugu.desktop-tail/1', scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64),
  commitSeq: 0, tail: null, sourceEnd: 0, sourceFence: { start: 0, end: 0, digest: 'c'.repeat(64) }, decoderVersion: 1 });
function fixture() {
  let current = head(), pending: PreparedSegment | null = null, failure = '', frame = 0, identityCommit = 0;
  const events: string[] = [], frames = new Map<string, Uint8Array>();
  const step = (name: string) => { events.push(name); if (failure === name) throw new Error(name); };
  const io: TailCommitIo = {
    async readHead(budget) { await budget.read('indexBytes', 4096, async () => 4096); return current; },
    async readPending(budget) { await budget.read('indexBytes', 4096, async () => 4096); return pending; },
    async readWrites(ref, budget) { await budget.read('indexBytes', 16_384, async () => 16_384);
      return JSON.parse(Buffer.from(frames.get(ref.id)!).toString()) as SegmentWrites; },
    async persistFrame(kind, bytes) { step(kind); const id = `frame:${++frame}`; frames.set(id, bytes);
      return { id, offset: 0, length: bytes.length, digest: 'd'.repeat(64) } satisfies SegmentRef; },
    async persistPending(value) { pending = value; step('pending'); },
    async validateSourceFence(_head, budget) { await budget.read('sourceBytes', 4096, async () => 4096); return failure !== 'source'; },
    async commitIdentity(seq, _published, _receipts, _aliases, budget) {
      await budget.read('indexBytes', 32_768, async () => 32_768); identityCommit = seq; step('identity');
    },
    async publishHead(value) { step('publish'); current = value; step('published'); },
    async clearPending() { step('clear'); pending = null; },
  };
  const input = () => ({ previous: current, sourceRange: { start: 0, end: 4 }, sourceFence: { start: 0, end: 4, digest: 'c'.repeat(64) },
    projection: Buffer.from('body'), decoderCheckpoint: Buffer.from('{}'), writes: { receipts: [], aliases: [] }, budget: createWindowBudget() });
  return { io, input, events, current: () => current, pending: () => pending, identity: () => identityCommit, fail(name: string) { failure = name; } };
}

it('publishes only after durable frames, recoverable write set and matching identity commit', async () => {
  const f = fixture(), writer = createTailCommitter(f.io);
  const prepared = await writer.prepareSegment(f.input());
  expect(f.current().commitSeq).toBe(0);
  const budget = createWindowBudget();
  expect((await writer.commitPreparedSegment(prepared, budget)).commitSeq).toBe(1);
  expect(f.events).toEqual(['projection', 'checkpoint', 'checkpoint', 'segment', 'pending', 'identity', 'publish', 'published', 'clear']);
  expect(budget.counters.indexBytes).toBe(57_344);
});

it('recovers the exact pending segment after interruption without rereading projection or source history', async () => {
  for (const stage of ['pending', 'identity', 'publish', 'published', 'clear']) {
    const f = fixture(), writer = createTailCommitter(f.io);
    f.fail(stage);
    if (stage === 'pending') await expect(writer.prepareSegment(f.input())).rejects.toThrow(stage);
    else { const prepared = await writer.prepareSegment(f.input()); await expect(writer.commitPreparedSegment(prepared, createWindowBudget())).rejects.toThrow(stage); }
    if (stage === 'identity' || stage === 'publish') expect(f.identity() > f.current().commitSeq).toBe(true);
    const original = f.pending()!.head.tail;
    f.fail('');
    const budget = createWindowBudget(), recovered = await createTailCommitter(f.io).recoverPending(budget);
    expect(recovered?.tail).toEqual(original);
    expect(recovered?.commitSeq).toBe(1);
    expect(f.pending()).toBeNull();
    expect(budget.counters.indexBytes).toBeLessThanOrEqual(64 * 1024);
  }
});

it('leaves the old head intact when frame persistence or the source fence fails', async () => {
  for (const stage of ['projection', 'checkpoint', 'segment', 'source']) {
    const f = fixture(), writer = createTailCommitter(f.io);
    f.fail(stage);
    if (stage === 'source') { const prepared = await writer.prepareSegment(f.input()); await expect(writer.commitPreparedSegment(prepared, createWindowBudget())).rejects.toThrow('source fence'); }
    else await expect(writer.prepareSegment(f.input())).rejects.toThrow(stage);
    expect(f.current().commitSeq).toBe(0); expect(f.identity()).toBe(0);
  }
});

it('rejects a new write set until the durable pending intent is recovered', async () => {
  const f = fixture(), writer = createTailCommitter(f.io);
  await writer.prepareSegment(f.input());
  await expect(writer.prepareSegment(f.input())).rejects.toThrow('Recover the pending');
  const excessive = f.input(); excessive.projection = Buffer.alloc(60 * 1024 + 1);
  const fresh = fixture();
  await expect(createTailCommitter(fresh.io).prepareSegment({ ...excessive, budget: createWindowBudget() })).rejects.toThrow('Invalid bounded');
});
