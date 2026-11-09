import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { readWindowFrame, writeWindowFrame } from './window-commit-projection-disk';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget, WindowIoCounters } from '@gugu/session-core/session-record/window-cache/types';
import { advanceCommitContainerIndex, readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { createWindowCommitReader } from './window-commit-reader';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { assertWindowCommitSource } from './window-commit-source';
import { COMMIT_HEADER_CHILDREN, commitHeaderFields, filterCommitHeader, type CommitHeader, type CommitHeaderTarget } from './window-commit-header-fields';

type Context = { directory: string; receipt: WindowCommitReceipt; receipts: Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'> };
type Input = Context & { index: CommitContainerIndex; target: CommitHeaderTarget; headerId: string;
  observed?(io: Readonly<WindowIoCounters>): void; report?(error: unknown): void };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (receipt: WindowCommitReceipt, id: string) => ({ ...receipt.binding, kind: 'projection' as const, cursor: `header:1:${id}` });
function committed(c: Context) {
  const actual = c.receipts.bySource(c.receipt.sourceId);
  if (!actual || JSON.stringify(snapshotWindowCommitReceipt(actual)) !== JSON.stringify(c.receipt)) throw new Error('Header lost its committed receipt');
}
function encode(header: CommitHeader) {
  const bytes = Buffer.from(JSON.stringify(header));
  if (bytes.length > 16384) throw new Error('Canonical header exceeds 16 KiB');
  return bytes;
}

/** A fixed whitelist, at most two object levels. Arrays and large strings are
 * opaque ranges; neither metadata nor body arrays are ever JSON.parse'd here.
 * The producer uses a fresh bounded I/O step then yields, not an unbounded
 * request budget. A crash restarts this one entity before its immutable publish. */
export async function publishCommitHeader(input: Input, signal?: AbortSignal) {
  const c: Context = { directory: input.directory, receipt: snapshotWindowCommitReceipt(input.receipt), receipts: input.receipts };
  const target = input.target, headerId = input.headerId;
  if (!/^[a-f0-9]{32,64}$/.test(headerId)) throw new Error('Invalid header identity');
  committed(c); signal?.throwIfAborted();
  const result: CommitHeader = { target, values: {}, deferred: [] };
  const tasks: Array<{ index: CommitContainerIndex; prefix: string; fields: Set<string>; build: boolean }> = [
    { index: { ...input.index, range: { ...input.index.range } }, prefix: '', fields: commitHeaderFields(target), build: false },
  ];
  async function step<T>(run: (budget: WindowBudget) => Promise<T>): Promise<T> {
    const budget = createWindowBudget();
    try { return await run(budget); }
    finally {
      try { input.observed?.(budget.counters); } catch (error) { try { input.report?.(error); } catch { /* diagnostics only */ } }
    }
  }
  for (let task = 0; task < tasks.length; task++) {
    const selected = tasks[task], context = { ...c, binding: c.receipt.binding, source: c.receipt.source, index: selected.index };
    if (selected.build) for (;;) {
      const built = await step(b => advanceCommitContainerIndex(context, b, signal));
      if (built.kind === 'rebuild') throw new Error('Header object index needs a rebuild');
      if (built.kind === 'complete') break;
      await setImmediate(undefined, { signal });
    }
    let page = 0, member = 0, done = false;
    while (!done) {
      await step(async budget => {
        const found = await readIndexedCommitContainerPage(context, page, budget, signal);
        if (found.kind === 'end') { done = true; return; }
        if (found.kind !== 'page') throw new Error('Header index is incomplete');
        const value = found.page.members[member];
        if (!value?.key) throw new Error('Invalid header object member');
        const reader = createWindowCommitReader(c.directory, c.receipt.binding, c.receipt.source, budget, signal);
        try {
          const decoded = value.key.end - value.key.start <= 512 ? await reader.string(
            { start: value.key.start + 1, end: value.key.end }, { rawOffset: value.key.start + 1, decodedOffset: 0 }, 128) : null;
          if (decoded?.complete && selected.fields.has(decoded.text)) {
            const name = decoded.text, field = `${selected.prefix}${name}`;
            if (Object.hasOwn(result.values, field) || result.deferred.some(v => v.field === field)) throw new Error('Duplicate canonical header field');
            const children = !selected.prefix && COMMIT_HEADER_CHILDREN[`${target}:${name}`];
            if (children && value.kind === 'object') {
              tasks.push({ index: { kind: 'object', range: { ...value.range }, buildId: hash([headerId, name]) },
                prefix: `${name}.`, fields: new Set(children.split(' ')), build: true });
            } else if (value.kind === 'primitive') result.values[field] = value.value;
            else if (value.kind === 'string') {
              const text = await reader.string({ start: value.range.start + 1, end: value.range.end },
                { rawOffset: value.range.start + 1, decodedOffset: 0 }, 512);
              if (text.complete && Buffer.byteLength(JSON.stringify(result.values)) + Buffer.byteLength(text.text) <= 8192)
                result.values[field] = text.text;
              else result.deferred.push({ field, kind: 'string', range: { ...value.range } });
            } else result.deferred.push({ field, kind: value.kind, range: { ...value.range } });
          }
        } finally { reader.close(); }
        if (member + 1 < found.page.members.length) member++;
        else if (found.next !== null) { page = found.next; member = 0; }
        else done = true;
      });
      committed(c); await setImmediate(undefined, { signal });
    }
  }
  const header = filterCommitHeader(result), bytes = encode(header);
  const identity = target === 'turn' ? header.values.referenceId === c.receipt.referenceId && header.values.seq === c.receipt.storedSeq : true;
  if (!identity) throw new Error('Header receipt identity mismatch');
  await step(async budget => {
    try { await writeWindowFrame(c.directory, key(c.receipt, headerId), bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const old = await readWindowFrame(c.directory, key(c.receipt, headerId), budget);
      if (old.kind === 'miss' && old.reason === 'io') throw old.error;
      if (old.kind !== 'hit' || !Buffer.from(old.bytes).equals(bytes)) throw new Error('Conflicting immutable header');
    }
  });
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted();
  return header;
}

/** Only host-published immutable headers can be read. Cache bytes remain
 * untrusted: pick the vocabulary and validate every deferred source range. */
export async function readCommitHeader(input: Context & { target: CommitHeaderTarget; range: { start: number; end: number } },
  id: string, budget: WindowBudget, signal?: AbortSignal): Promise<CommitHeader> {
  const c = { directory: input.directory, receipts: input.receipts, target: input.target,
    range: { ...input.range }, receipt: snapshotWindowCommitReceipt(input.receipt) }; committed(c); signal?.throwIfAborted();
  if (!/^[a-f0-9]{32,64}$/.test(id)) throw new Error('Invalid header identity');
  const saved = await readWindowFrame(c.directory, key(c.receipt, id), budget);
  if (saved.kind === 'miss' && saved.reason === 'io') throw saved.error;
  if (saved.kind !== 'hit' || saved.bytes.length > 16384) throw Object.assign(new Error('Header needs a rebuild'), { code: 'needs_location' });
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes)) as CommitHeader;
  if (!raw || raw.target !== c.target || !raw.values || Array.isArray(raw.values)
    || !Array.isArray(raw.deferred) || raw.deferred.length > 64) throw new Error('Invalid canonical header');
  const values = Object.fromEntries(Object.entries(raw.values).map(([field, value]) => {
    if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && Buffer.byteLength(value) <= 512)) throw new Error('Invalid header scalar');
    return [field, value];
  }));
  const deferred = raw.deferred.map(value => {
    const r = value?.range;
    if (!value || !['string', 'array', 'object'].includes(value.kind) || !r || !Number.isSafeInteger(r.start)
      || !Number.isSafeInteger(r.end) || r.start <= c.range.start || r.end <= r.start || r.end >= c.range.end) throw new Error('Invalid header field range');
    return { field: value.field, kind: value.kind, range: { start: r.start, end: r.end } };
  });
  const header = filterCommitHeader({ target: raw.target, values, deferred }); encode(header);
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted();
  return header;
}
