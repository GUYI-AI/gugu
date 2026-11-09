import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createWindowCommitReader } from './window-commit-reader';
import { snapshotWindowCommitReceipt, type WindowCommitReceipt } from './window-commit-receipt';
import { readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { assertWindowCommitSource } from './window-commit-source';

type Range = { start: number; end: number };
type Facts = { turnId?: string; referenceId?: string; storedSeq?: number; items?: Range; terminals?: Range };
export type CommitRootState = { version: 1; sourceId: string; buildId: string; page: number; member: number; done: boolean; facts: Facts };
export type CommitRootFacts = Readonly<Facts & { sourceId: string; turnId: string; referenceId: string; storedSeq: number; items: Range }>;
const issued = new WeakSet<CommitRootFacts>();
export const isIssuedCommitRootFacts = (facts: CommitRootFacts) => issued.has(facts);
const position = (n: number) => Number.isSafeInteger(n) && n >= 0;
const small = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 2048 && Buffer.byteLength(s) <= 2048;
function anchor(receipt: WindowCommitReceipt, index: CommitContainerIndex) {
  if (typeof index.buildId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(index.buildId)
    || index.kind !== 'object' || index.range.start !== 0 || index.range.end !== receipt.source.bytes)
    throw new Error('Root projection needs the actual complete canonical root range');
}
export function createCommitRootState(receipt: WindowCommitReceipt, index: CommitContainerIndex): CommitRootState {
  anchor(receipt, index);
  return { version: 1, sourceId: receipt.sourceId, buildId: index.buildId, page: 0, member: 0, done: false, facts: {} };
}
function state(receipt: WindowCommitReceipt, index: CommitContainerIndex, input: CommitRootState): CommitRootState {
  anchor(receipt, index);
  if (!input || input.version !== 1 || input.sourceId !== receipt.sourceId || input.buildId !== index.buildId
    || !position(input.page) || input.page > receipt.source.bytes || !position(input.member) || input.member > 15 || typeof input.done !== 'boolean' || !input.facts)
    throw new Error('Invalid canonical root checkpoint');
  const f = input.facts, facts: Facts = {};
  if (f.turnId !== undefined) { if (!small(f.turnId)) throw new Error('Invalid root identity'); facts.turnId = f.turnId; }
  if (f.referenceId !== undefined) {
    if (f.referenceId !== receipt.referenceId) throw new Error('Canonical root reference mismatch'); facts.referenceId = f.referenceId;
  }
  if (f.storedSeq !== undefined) {
    if (f.storedSeq !== receipt.storedSeq) throw new Error('Canonical stored sequence mismatch'); facts.storedSeq = f.storedSeq;
  }
  for (const name of ['items', 'terminals'] as const) if (f[name] !== undefined) {
    const r = f[name];
    if (!r || !position(r.start) || r.start < 1 || !position(r.end) || r.end <= r.start || r.end >= receipt.source.bytes)
      throw new Error('Invalid canonical root child range');
    facts[name] = { start: r.start, end: r.end };
  }
  return { version: 1, sourceId: receipt.sourceId, buildId: index.buildId, page: input.page, member: input.member, done: input.done, facts };
}
export function resumeCommitRootState(receipt: WindowCommitReceipt, index: CommitContainerIndex, input: CommitRootState): CommitRootState {
  return state(receipt, index, input);
}
function complete(s: CommitRootState): CommitRootFacts {
  if (!s.facts.turnId || !s.facts.referenceId || s.facts.storedSeq === undefined || !s.facts.items)
    throw new Error('Canonical root identity/items are incomplete');
  const facts: CommitRootFacts = Object.freeze({ ...s.facts, sourceId: s.sourceId, turnId: s.facts.turnId,
    referenceId: s.facts.referenceId, storedSeq: s.facts.storedSeq, items: Object.freeze({ ...s.facts.items }),
    ...(s.facts.terminals ? { terminals: Object.freeze({ ...s.facts.terminals }) } : {}) });
  issued.add(facts); return facts;
}

/** Read exactly one root member per step. Canonical ids come from the stored
 * source, while seq/reference are checked against its transactional receipt.
 * Large payloads/metadata remain byte ranges. This is not an ACK publisher or
 * a lease/row authorization API; its caller owns and validates that receipt. */
async function rootMember(directory: string, inputReceipt: WindowCommitReceipt, inputIndex: CommitContainerIndex,
  input: CommitRootState, budget: WindowBudget, signal: AbortSignal | undefined, reader: ReturnType<typeof createWindowCommitReader>) {
  const index: CommitContainerIndex = { buildId: inputIndex.buildId, kind: inputIndex.kind, range: { ...inputIndex.range } };
  const receipt = snapshotWindowCommitReceipt(inputReceipt), next = state(receipt, index, input);
  signal?.throwIfAborted();
  if (next.done) {
    await assertWindowCommitSource(directory, receipt.binding, receipt.source); signal?.throwIfAborted();
    return { kind: 'complete' as const, state: next, facts: complete(next) };
  }
  const result = await readIndexedCommitContainerPage({ directory, binding: receipt.binding, source: receipt.source, index }, next.page, budget, signal);
  if (result.kind === 'rebuild' || result.kind === 'pending') return result;
  if (result.kind === 'end') return { kind: 'complete' as const, state: { ...next, done: true }, facts: complete(next) };
  const member = result.page.members[next.member];
  if (!member?.key) throw new Error('Canonical root member checkpoint is outside its page');
  {
    // Known schema names are short even when escaped; giant unknown keys stay opaque.
    const name = member.key.end - member.key.start > 512 ? null : await reader.string(
      { start: member.key.start + 1, end: member.key.end }, { rawOffset: member.key.start + 1, decodedOffset: 0 }, 128);
    const field = name?.complete ? name.text : null;
    if (field === 'id' || field === 'referenceId') {
      if (member.kind !== 'string') throw new Error('Canonical root identity must be a string');
      const value = await reader.string({ start: member.range.start + 1, end: member.range.end },
        { rawOffset: member.range.start + 1, decodedOffset: 0 }, 2048);
      if (!value.complete || !small(value.text)) throw new Error('Invalid canonical root identity');
      if (field === 'referenceId' && value.text !== receipt.referenceId) throw new Error('Canonical root reference mismatch');
      if (field === 'id') next.facts.turnId = value.text; else next.facts.referenceId = value.text;
    } else if (field === 'seq') {
      if (member.kind !== 'primitive' || member.value !== receipt.storedSeq) throw new Error('Canonical stored sequence mismatch');
      next.facts.storedSeq = receipt.storedSeq;
    } else if (field === 'items' || field === 'terminals') {
      if (member.kind !== 'array') throw new Error('Canonical root children must be arrays');
      next.facts[field] = { ...member.range };
    }
  }
  if (next.member + 1 < result.page.members.length) next.member++;
  else if (result.next !== null) { next.page = result.next; next.member = 0; }
  else next.done = true;
  return next.done ? { kind: 'complete' as const, state: next, facts: complete(next) } : { kind: 'progress' as const, state: next };
}

/** Single-member compatibility entry. The batch below owns the same two-frame
 * reader across a bounded set of members; neither path accepts a foreign reader. */
export async function advanceCommitRootFields(directory: string, inputReceipt: WindowCommitReceipt, inputIndex: CommitContainerIndex,
  input: CommitRootState, budget: WindowBudget, signal?: AbortSignal) {
  const receipt = snapshotWindowCommitReceipt(inputReceipt), index = { ...inputIndex, range: { ...inputIndex.range } };
  const reader = createWindowCommitReader(directory, receipt.binding, receipt.source, budget, signal);
  try { return await rootMember(directory, receipt, index, input, budget, signal, reader); }
  finally { reader.close(); }
}

/** At most 16 members. Reserve over 48 KiB for another worst-case member:
 * two <=20 KiB source frames plus the <=4 KiB index head and framed page.
 * The caller still owns the one 64 KiB budget and durable checkpoint. */
export async function advanceCommitRootBatch(directory: string, inputReceipt: WindowCommitReceipt, inputIndex: CommitContainerIndex,
  input: CommitRootState, budget: WindowBudget, signal?: AbortSignal) {
  const receipt = snapshotWindowCommitReceipt(inputReceipt), index = { ...inputIndex, range: { ...inputIndex.range } };
  const reader = createWindowCommitReader(directory, receipt.binding, receipt.source, budget, signal);
  try {
    let result = await rootMember(directory, receipt, index, input, budget, signal, reader);
    for (let count = 1; result.kind === 'progress' && count < 16 && budget.counters.indexBytes <= 12 * 1024; count++)
      result = await rootMember(directory, receipt, index, result.state, budget, signal, reader);
    return result;
  } finally { reader.close(); }
}
