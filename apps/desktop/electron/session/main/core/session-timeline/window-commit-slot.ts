import { createHash } from 'node:crypto';
import { readWindowFrame, writeWindowFrame } from './window-commit-projection-disk';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { isIssuedCommitEntityFacts, type CommitEntityFacts } from './window-commit-entity';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { readWindowCommitStringPage } from './window-commit-body';
import { assertWindowCommitSource } from './window-commit-source';

type Receipts = Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>;
type Position = { rawOffset: number; decodedOffset: number };
export type CommitBodySlot = Readonly<{ id: string; sourceId: string; rowId: string; turnId: string;
  entity: 'item' | 'terminal'; entityId: string; field: string; range: Readonly<{ start: number; end: number }> }>;
type Context = { directory: string; receipts: Receipts; receipt: WindowCommitReceipt };
type Head = { version: 1; slotId: string; next: Position; previous: number | null; complete: boolean };
type Page = { version: 1; slotId: string; offset: number; previous: number | null; next: Position; rawStart: number;
  complete: boolean; bytes: number; digest: string };
const slots = new WeakMap<CommitBodySlot, Context>();
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function committed(c: Context) {
  const stored = c.receipts.bySource(c.receipt.sourceId);
  if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(c.receipt)) throw new Error('Body slot lost its committed receipt');
}
function context(slot: CommitBodySlot) { const c = slots.get(slot); if (!c) throw new Error('Unknown canonical body slot'); committed(c); return c; }
/** Private producer capability, never a renderer-supplied range or old bodyRef.
 * A cache rebuild opens a new buildId so delivered slot pages stay immutable. */
export function openCommitBodySlot(directory: string, receipts: Receipts, input: WindowCommitReceipt,
  entity: CommitEntityFacts, field: string, buildId: string): CommitBodySlot {
  const receipt = snapshotWindowCommitReceipt(input);
  if (!isIssuedCommitEntityFacts(entity)) throw new Error('Invalid canonical body owner/slot');
  const selected = entity.slots.find(value => value.field === field);
  if (!selected || entity.sourceId !== receipt.sourceId || entity.rowId !== receipt.rowId
    || !/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) throw new Error('Invalid canonical body owner/slot');
  const c = { directory, receipts, receipt }; committed(c);
  const id = hash(JSON.stringify([receipt.sourceId, entity.turnId, entity.entity, entity.id, field, selected.range, buildId]));
  const slot = Object.freeze({ id, sourceId: receipt.sourceId, rowId: receipt.rowId, turnId: entity.turnId, entity: entity.entity,
    entityId: entity.id, field, range: Object.freeze({ start: selected.range.start + 1, end: selected.range.end }) });
  slots.set(slot, c); return slot;
}
function key(c: Context, slot: CommitBodySlot, part: 'head' | 'page' | 'body', offset = 0) {
  return { ...c.receipt.binding, kind: part === 'head' ? 'head' as const : part === 'body' ? 'body' as const : 'locator' as const,
    cursor: `slot:${slot.id}:${part}:${offset}` };
}
function position(slot: CommitBodySlot, value: Position, complete: boolean) {
  return value && integer(value.rawOffset) && integer(value.decodedOffset) && value.rawOffset >= slot.range.start
    && value.rawOffset <= slot.range.end && value.decodedOffset <= value.rawOffset - slot.range.start
    && (complete ? value.rawOffset === slot.range.end : value.rawOffset < slot.range.end);
}
function parse(raw: Uint8Array): unknown {
  if (raw.length > 2048) throw new Error('Invalid slot metadata size');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
}
function head(slot: CommitBodySlot, value: unknown): Head {
  const h = value as Head;
  if (!h || h.version !== 1 || h.slotId !== slot.id || typeof h.complete !== 'boolean' || !position(slot, h.next, h.complete)
    || (h.previous === null ? h.next.decodedOffset !== 0 : !integer(h.previous) || h.previous > h.next.decodedOffset
      || !h.complete && h.previous === h.next.decodedOffset)) throw new Error('Invalid body checkpoint');
  return { version: 1, slotId: slot.id, next: { ...h.next }, previous: h.previous, complete: h.complete };
}
function page(slot: CommitBodySlot, value: unknown, offset: number): Page {
  const p = value as Page;
  if (!p || p.version !== 1 || p.slotId !== slot.id || p.offset !== offset || typeof p.complete !== 'boolean' || !position(slot, p.next, p.complete)
    || !integer(p.rawStart) || p.rawStart < slot.range.start || p.rawStart >= p.next.rawOffset || offset > p.rawStart - slot.range.start
    || !integer(p.bytes) || p.bytes > 16384 || p.bytes !== p.next.decodedOffset - offset || (!p.complete && p.bytes === 0)
    || !/^[a-f0-9]{64}$/.test(p.digest) || (offset === 0 ? p.previous !== null : !integer(p.previous!) || p.previous! >= offset))
    throw new Error('Invalid body page');
  return { version: 1, slotId: slot.id, offset, previous: p.previous, next: { ...p.next }, rawStart: p.rawStart,
    complete: p.complete, bytes: p.bytes, digest: p.digest };
}
async function load(c: Context, slot: CommitBodySlot, part: 'head' | 'page' | 'body', offset: number, budget: WindowBudget) {
  const result = await readWindowFrame(c.directory, key(c, slot, part, offset), budget);
  if (result.kind === 'miss' && result.reason === 'io') throw result.error;
  return result;
}
async function immutable(c: Context, slot: CommitBodySlot, part: 'page' | 'body', offset: number, bytes: Uint8Array, budget: WindowBudget) {
  try { await writeWindowFrame(c.directory, key(c, slot, part, offset), bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    const old = await load(c, slot, part, offset, budget);
    if (old.kind !== 'hit' || !Buffer.from(old.bytes).equals(bytes)) throw new Error('Conflicting immutable slot page; rebuild with a new version');
  }
}
async function physical(c: Context, signal?: AbortSignal) {
  signal?.throwIfAborted(); await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); signal?.throwIfAborted();
}
const rebuild = (slot: CommitBodySlot) => ({ kind: 'rebuild' as const, anchor: { sourceId: slot.sourceId, ...slot.range } });

/** One decoded UTF-8 page per budget. Content + point descriptor are durable
 * before advancing the small checkpoint. Byte offsets are actual published
 * UTF-8 boundaries; lookup never walks previous chunks or keeps an offset array. */
export async function advanceCommitBodySlot(slot: CommitBodySlot, budget: WindowBudget, signal?: AbortSignal) {
  const c = context(slot); signal?.throwIfAborted();
  const saved = await load(c, slot, 'head', 0, budget);
  let h: Head;
  try {
    if (saved.kind === 'miss' && saved.reason !== 'not_found') return rebuild(slot);
    h = saved.kind === 'hit' ? head(slot, parse(saved.bytes)) : { version: 1, slotId: slot.id,
      next: { rawOffset: slot.range.start, decodedOffset: 0 }, previous: null, complete: false };
  } catch { return rebuild(slot); }
  if (h.complete) { await physical(c, signal); committed(c); signal?.throwIfAborted(); return { kind: 'complete' as const, byteLength: h.next.decodedOffset }; }
  const decoded = await readWindowCommitStringPage(c.directory, c.receipt.binding, c.receipt.source,
    { range: slot.range, position: h.next, maxBytes: 16384, budget, signal });
  const content = Buffer.from(decoded.text, 'utf8'), offset = h.next.decodedOffset;
  const p: Page = { version: 1, slotId: slot.id, offset, previous: h.previous, rawStart: h.next.rawOffset,
    next: decoded.next, complete: decoded.complete, bytes: content.length, digest: hash(content) };
  await immutable(c, slot, 'body', offset, content, budget); signal?.throwIfAborted();
  await immutable(c, slot, 'page', offset, Buffer.from(JSON.stringify(p)), budget); await physical(c, signal); committed(c);
  const next: Head = { version: 1, slotId: slot.id, next: decoded.next, previous: offset, complete: decoded.complete };
  await writeWindowFrame(c.directory, key(c, slot, 'head'), Buffer.from(JSON.stringify(next)));
  await physical(c, signal); committed(c); signal?.throwIfAborted();
  return { kind: decoded.complete ? 'complete' as const : 'progress' as const, byteLength: decoded.complete ? decoded.next.decodedOffset : null,
    offset, nextOffset: decoded.next.decodedOffset };
}

export async function readCommitBodySlot(slot: CommitBodySlot, offset: number, budget: WindowBudget, signal?: AbortSignal) {
  const c = context(slot); signal?.throwIfAborted(); if (!integer(offset)) throw new Error('Invalid body page offset');
  const saved = await load(c, slot, 'page', offset, budget); let p: Page;
  try { if (saved.kind !== 'hit') return rebuild(slot); p = page(slot, parse(saved.bytes), offset); } catch { return rebuild(slot); }
  const content = await load(c, slot, 'body', offset, budget);
  if (content.kind !== 'hit' || content.bytes.length !== p.bytes || hash(content.bytes) !== p.digest) return rebuild(slot);
  budget.charge('decodedBytes', p.bytes); budget.charge('outputBytes', p.bytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
  await physical(c, signal); committed(c); signal?.throwIfAborted();
  return { kind: 'body' as const, slotId: slot.id, offset, text, previousOffset: p.previous,
    nextOffset: p.next.decodedOffset, moreAfter: p.complete ? 'no' as const : 'yes' as const };
}
