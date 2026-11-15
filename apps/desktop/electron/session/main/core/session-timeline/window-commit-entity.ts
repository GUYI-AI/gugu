import { createHash } from 'node:crypto';
import { readWindowFrame } from './window-commit-projection-disk';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { readWindowCommitProjection } from './window-commit-projection';
import { isIssuedCommitRootFacts, type CommitRootFacts } from './window-commit-root';
import { readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { createWindowCommitReader } from './window-commit-reader';
import { assertWindowCommitSource } from './window-commit-source';

type Range = { start: number; end: number };
type Entity = 'item' | 'terminal';
type Field = 'text' | 'outputText' | 'rawOutput' | 'rawInput' | 'output';
type Candidate = { range: Range; string: boolean };
export type CommitArrayAnchor = Readonly<{ sourceId: string; turnId: string; entity: Entity; range: Range }>;
export type CommitEntityPosition = Readonly<{ sourceId: string; rowId: string; turnId: string; entity: Entity; range: Range; buildId: string }>;
export type CommitEntityState = { version: 1; sourceId: string; buildId: string; page: number; member: number; done: boolean;
  id?: string; kind?: string; children?: Range; candidates: Partial<Record<Field, Candidate>> };
export type CommitEntityFacts = Readonly<{ sourceId: string; rowId: string; turnId: string; entity: Entity; id: string; kind: string;
  children?: Range; slots: readonly Readonly<{ field: Field; range: Range }>[] }>;
const anchors = new WeakSet<CommitArrayAnchor>(), entities = new WeakSet<CommitEntityFacts>();
export const isIssuedCommitEntityFacts = (facts: CommitEntityFacts) => entities.has(facts);
type Context = { directory: string; receipt: WindowCommitReceipt; index: CommitContainerIndex };
const positions = new WeakMap<CommitEntityPosition, Context>();
const fields: readonly Field[] = ['text', 'outputText', 'rawOutput', 'rawInput', 'output'];
const same = (a: Range, b: Range) => a.start === b.start && a.end === b.end;
const small = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 2048 && Buffer.byteLength(s) <= 2048;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
function anchor(sourceId: string, turnId: string, entity: Entity, range: Range): CommitArrayAnchor {
  const result = Object.freeze({ sourceId, turnId, entity, range: Object.freeze({ ...range }) }); anchors.add(result); return result;
}
export function commitRootArray(root: CommitRootFacts, entity: Entity): CommitArrayAnchor | null {
  if (!isIssuedCommitRootFacts(root) || !['item', 'terminal'].includes(entity)) throw new Error('Root facts were not issued by the canonical projection reader');
  const range = entity === 'item' ? root.items : root.terminals;
  return range ? anchor(root.sourceId, root.turnId, entity, range) : null;
}
export function commitChildArray(parent: CommitEntityFacts): CommitArrayAnchor | null {
  if (!entities.has(parent)) throw new Error('Parent facts were not issued by the canonical projection reader');
  return parent.children ? anchor(parent.sourceId, parent.turnId, 'item', parent.children) : null;
}

/** Membership is point-read from the actual parent array index. Neither a raw
 * renderer-supplied range nor a runtime-relative id can create this position. */
export async function openCommitEntity(directory: string, inputReceipt: WindowCommitReceipt, parent: CommitArrayAnchor,
  array: CommitContainerIndex, page: number, member: number, buildId: string, budget: WindowBudget, signal?: AbortSignal) {
  const receipt = snapshotWindowCommitReceipt(inputReceipt), index: CommitContainerIndex = { ...array, range: { ...array.range } };
  if (!anchors.has(parent) || parent.sourceId !== receipt.sourceId || index.kind !== 'array' || !same(index.range, parent.range)
    || !integer(member) || member > 15 || !/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) throw new Error('Invalid canonical entity anchor');
  const result = await readIndexedCommitContainerPage({ directory, binding: receipt.binding, source: receipt.source, index }, page, budget, signal);
  if (result.kind !== 'page') return result;
  const selected = result.page.members[member];
  if (!selected || selected.kind !== 'object') throw new Error('Canonical entity must be a real object member');
  const position = Object.freeze({ sourceId: receipt.sourceId, rowId: receipt.rowId, turnId: parent.turnId,
    entity: parent.entity, range: Object.freeze({ ...selected.range }), buildId });
  positions.set(position, { directory, receipt, index: { buildId, kind: 'object', range: { ...selected.range } } });
  return { kind: 'position' as const, position };
}
export function commitEntityIndex(position: CommitEntityPosition): CommitContainerIndex {
  const c = positions.get(position); if (!c) throw new Error('Unknown canonical entity position');
  return { ...c.index, range: { ...c.index.range } };
}
export function createCommitEntityState(p: CommitEntityPosition): CommitEntityState {
  if (!positions.has(p)) throw new Error('Unknown canonical entity position');
  return { version: 1, sourceId: p.sourceId, buildId: p.buildId, page: 0, member: 0, done: false, candidates: {} };
}
function state(p: CommitEntityPosition, input: CommitEntityState): CommitEntityState {
  if (!input || input.version !== 1 || input.sourceId !== p.sourceId || input.buildId !== p.buildId
    || !integer(input.page) || !integer(input.member) || input.member > 15 || typeof input.done !== 'boolean' || !input.candidates
    || typeof input.candidates !== 'object' || Array.isArray(input.candidates)
    || (input.id !== undefined && !small(input.id)) || (input.kind !== undefined && !small(input.kind))) throw new Error('Invalid entity checkpoint');
  const valid = (r: Range) => r && integer(r.start) && integer(r.end) && r.start > p.range.start && r.end > r.start && r.end < p.range.end;
  const candidates: CommitEntityState['candidates'] = {};
  for (const field of fields) if (input.candidates[field]) {
    const value = input.candidates[field];
    if (!valid(value.range) || typeof value.string !== 'boolean') throw new Error('Invalid entity body range');
    candidates[field] = { range: { ...value.range }, string: value.string };
  }
  if (input.children && !valid(input.children)) throw new Error('Invalid child entity range');
  return { version: 1, sourceId: p.sourceId, buildId: p.buildId, page: input.page, member: input.member, done: input.done,
    id: input.id, kind: input.kind, children: input.children && { ...input.children }, candidates };
}
function finish(p: CommitEntityPosition, s: CommitEntityState): CommitEntityFacts {
  const kind = p.entity === 'terminal' ? 'terminal' : s.kind;
  if (!s.id || !kind) throw new Error('Canonical entity identity is incomplete');
  const allowed: readonly Field[] = p.entity === 'terminal' ? ['output'] : kind === 'message' || kind === 'thinking' ? ['text']
    : kind.endsWith('-tool-call') ? ['outputText', 'rawOutput', 'rawInput'] : [];
  const slots = allowed.flatMap(field => {
    const value = s.candidates[field]; if (!value) return [];
    if (!value.string) throw new Error('Canonical body slot must be a string');
    return [Object.freeze({ field, range: Object.freeze({ ...value.range }) })];
  });
  const children = p.entity === 'item' && (kind === 'tool-group' || kind.endsWith('-tool-call')) ? s.children : undefined;
  const facts = Object.freeze({ sourceId: p.sourceId, rowId: p.rowId, turnId: p.turnId, entity: p.entity, id: s.id, kind,
    ...(children ? { children: Object.freeze({ ...children }) } : {}), slots: Object.freeze(slots) });
  entities.add(facts); return facts;
}

/** One field per step; exact slots stay ranges in the same entity. No second
 * message/tool or guessed stdout/body alias is created. Lease/ACK ownership is
 * above these private producer objects, which are not public wire types. */
export async function advanceCommitEntityFields(p: CommitEntityPosition, input: CommitEntityState, budget: WindowBudget, signal?: AbortSignal) {
  const c = positions.get(p); if (!c) throw new Error('Unknown canonical entity position');
  const next = state(p, input); signal?.throwIfAborted();
  if (next.done) { await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); signal?.throwIfAborted();
    return { kind: 'complete' as const, state: next, facts: finish(p, next) }; }
  const result = await readIndexedCommitContainerPage({ ...c, binding: c.receipt.binding, source: c.receipt.source }, next.page, budget, signal);
  if (result.kind !== 'page') return result;
  const member = result.page.members[next.member]; if (!member?.key) throw new Error('Entity checkpoint is outside its page');
  const reader = createWindowCommitReader(c.directory, c.receipt.binding, c.receipt.source, budget, signal);
  try {
    const name = member.key.end - member.key.start > 512 ? null : await reader.string({ start: member.key.start + 1, end: member.key.end },
      { rawOffset: member.key.start + 1, decodedOffset: 0 }, 128);
    const field = name?.complete ? name.text : null;
    if (field === (p.entity === 'terminal' ? 'terminalId' : 'id') || p.entity === 'item' && field === 'kind') {
      if (member.kind !== 'string') throw new Error('Canonical entity identity must be a string');
      const value = await reader.string({ start: member.range.start + 1, end: member.range.end }, { rawOffset: member.range.start + 1, decodedOffset: 0 }, 2048);
      if (!value.complete || !small(value.text)) throw new Error('Invalid canonical entity identity');
      if (field === 'kind') next.kind = value.text; else next.id = value.text;
    } else if (field && fields.includes(field as Field)) next.candidates[field as Field] = { range: { ...member.range }, string: member.kind === 'string' };
    else if (field === 'children' && member.kind === 'array') next.children = { ...member.range };
  } finally { reader.close(); }
  if (next.member + 1 < result.page.members.length) next.member++;
  else if (result.next !== null) { next.page = result.next; next.member = 0; }
  else next.done = true;
  return next.done ? { kind: 'complete' as const, state: next, facts: finish(p, next) } : { kind: 'progress' as const, state: next };
}

export type CommitEntityPublication = { version: 1; rootBuildId: string; position: CommitEntityPosition; state: CommitEntityState };
const publicationId = (p: CommitEntityPosition) => createHash('sha256').update(JSON.stringify([
  p.sourceId, p.rowId, p.turnId, p.entity, p.range, p.buildId])).digest('hex');
export function commitEntityPublicationId(p: CommitEntityPosition) {
  if (!positions.has(p)) throw new Error('Unknown canonical entity position'); return publicationId(p);
}
export const commitEntityPublicationKey = (receipt: WindowCommitReceipt, id: string) => ({
  ...receipt.binding, kind: 'projection' as const, cursor: `entity:${id}`,
});

/** Reopen a host-written immutable entity page. Its root version, completed
 * object index and canonical receipt are validated before reissuing private
 * child/body capabilities. A renderer cannot provide these facts as a proof. */
export async function readCommitEntityPublication(directory: string, receipts: Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>,
  input: WindowCommitReceipt, id: string, budget: WindowBudget, signal?: AbortSignal) {
  const receipt = snapshotWindowCommitReceipt(input);
  const committed = () => {
    const stored = receipts.bySource(receipt.sourceId);
    if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(receipt)) throw new Error('Entity publication lost its committed receipt');
  };
  committed(); signal?.throwIfAborted(); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid entity publication id');
  const rebuild = () => ({ kind: 'rebuild' as const, anchor: { sourceId: receipt.sourceId, start: 0, end: receipt.source.bytes } });
  const loaded = await readWindowFrame(directory, commitEntityPublicationKey(receipt, id), budget);
  if (loaded.kind === 'miss' && loaded.reason === 'io') throw loaded.error;
  let value: CommitEntityPublication, p: CommitEntityPosition, saved: CommitEntityState;
  try {
    if (loaded.kind !== 'hit' || loaded.bytes.length > 8192) return rebuild();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes)) as CommitEntityPublication;
    const raw = value?.position;
    if (value?.version !== 1 || !/^[A-Za-z0-9_-]{1,48}$/.test(value.rootBuildId) || !raw
      || raw.sourceId !== receipt.sourceId || raw.rowId !== receipt.rowId || !small(raw.turnId) || !['item', 'terminal'].includes(raw.entity)
      || !raw.range || !integer(raw.range.start) || raw.range.start < 1 || !integer(raw.range.end) || raw.range.end <= raw.range.start
      || raw.range.end >= receipt.source.bytes || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.buildId)) return rebuild();
    p = Object.freeze({ sourceId: raw.sourceId, rowId: raw.rowId, turnId: raw.turnId, entity: raw.entity,
      buildId: raw.buildId, range: Object.freeze({ start: raw.range.start, end: raw.range.end }) });
    if (publicationId(p) !== id) return rebuild();
    saved = state(p, value.state); if (!saved.done) return rebuild();
  } catch { return rebuild(); }
  const root = await readWindowCommitProjection({ directory, receipts, receipt, buildId: value.rootBuildId }, budget, signal);
  if (root.kind !== 'projection' || root.root.turnId !== p.turnId) return rebuild();
  const index: CommitContainerIndex = { buildId: p.buildId, kind: 'object', range: { ...p.range } };
  const indexed = await readIndexedCommitContainerPage({ directory, binding: receipt.binding, source: receipt.source, index }, 0, budget, signal);
  if (indexed.kind !== 'page' && indexed.kind !== 'end') return rebuild();
  await assertWindowCommitSource(directory, receipt.binding, receipt.source); committed(); signal?.throwIfAborted();
  positions.set(p, { directory, receipt, index });
  return { kind: 'entity' as const, position: p, facts: finish(p, saved), rootBuildId: value.rootBuildId, bodyBuildId: id };
}
