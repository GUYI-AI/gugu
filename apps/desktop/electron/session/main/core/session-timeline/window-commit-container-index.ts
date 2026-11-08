import { createHash } from 'node:crypto';
import { readWindowFrame, writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createCommitContainerState, readCommitContainerPage, resumeCommitContainerState,
  type CommitContainerMember, type CommitContainerState } from './window-commit-container';
import type { WindowCommitSourceManifest, writeWindowCommitSource } from './window-commit-source';
import { assertWindowCommitSource } from './window-commit-source';

/** One caller-owned build/version. A rebuild uses a NEW buildId so a delivered
 * immutable page is never overwritten. Version pinning/GC belongs to the owner. */
export type CommitContainerIndex = { buildId: string; range: { start: number; end: number }; kind: 'object' | 'array' };
type Context = { directory: string; binding: Parameters<typeof writeWindowCommitSource>[1]; source: WindowCommitSourceManifest; index: CommitContainerIndex };
type Head = { version: 1; pages: number; state: CommitContainerState };
type Page = { version: 1; ordinal: number; members: CommitContainerMember[]; next: CommitContainerState };
const validPosition = (n: number) => Number.isSafeInteger(n) && n >= 0;
const encode = (value: Head | Page) => {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) throw new Error('Container index metadata exceeds 4 KiB');
  return bytes;
};
function initial(c: Context): CommitContainerState {
  if (typeof c.index.buildId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.index.buildId)) throw new Error('Invalid container build id');
  return createCommitContainerState(c.source, c.index.range, c.index.kind);
}
function frame(c: Context, page: number | null) {
  const id = createHash('sha256').update(JSON.stringify([c.index.buildId, c.index.kind, c.index.range.start, c.index.range.end])).digest('hex');
  return { ...c.binding, kind: page === null ? 'head' as const : 'projection' as const,
    cursor: `container:${id}:${page === null ? 'head' : page}` };
}
function state(c: Context, value: unknown): CommitContainerState {
  const s = resumeCommitContainerState(value, c.source);
  if (s.kind !== c.index.kind || s.range.start !== c.index.range.start || s.range.end !== c.index.range.end)
    throw new Error('Container index anchor mismatch');
  return s;
}
function parse(bytes: Uint8Array): unknown {
  if (bytes.length > 4096) throw new Error('Invalid container index size');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
function head(c: Context, value: unknown): Head {
  const h = value as Head;
  if (!h || h.version !== 1 || !validPosition(h.pages)) throw new Error('Invalid container index head');
  const s = state(c, h.state);
  if (h.pages > s.ordinal || (h.pages === 0 && s.ordinal !== 0)) throw new Error('Invalid container index page count');
  return { version: 1, pages: h.pages, state: s };
}
function page(c: Context, value: unknown, ordinal: number): Page {
  const p = value as Page;
  if (!p || p.version !== 1 || p.ordinal !== ordinal || !Array.isArray(p.members) || p.members.length < 1 || p.members.length > 16)
    throw new Error('Invalid container index page');
  const next = state(c, p.next), first = next.ordinal - p.members.length;
  if (first < 0) throw new Error('Invalid container index member count');
  let end = c.index.range.start;
  const validRange = (r: CommitContainerMember['range']) => r && validPosition(r.start) && validPosition(r.end) && r.start > end
    && r.end > r.start && r.end <= next.lex.offset;
  const members = p.members.map((m, i): CommitContainerMember => {
    if (!m || m.ordinal !== first + i || !validRange(m.range)
      || (c.index.kind === 'array' ? m.key !== null : !m.key || !validRange(m.key) || m.key.end > m.range.start)
      || !['primitive', 'string', 'object', 'array'].includes(m.kind)
      || (m.kind !== 'primitive' && m.range.end - m.range.start < 2)) throw new Error('Invalid indexed container member');
    end = m.range.end;
    const fields = { ordinal: m.ordinal, key: m.key && { start: m.key.start, end: m.key.end }, range: { start: m.range.start, end: m.range.end } };
    if (m.kind !== 'primitive') return { ...fields, kind: m.kind };
    if (!(m.value === null || typeof m.value === 'boolean' || typeof m.value === 'number' && Number.isFinite(m.value)))
      throw new Error('Invalid indexed primitive');
    return { ...fields, kind: 'primitive', value: m.value };
  });
  return { version: 1, ordinal, members, next };
}
async function load(c: Context, ordinal: number | null, budget: WindowBudget) {
  const result = await readWindowFrame(c.directory, frame(c, ordinal), budget);
  if (result.kind === 'miss' && result.reason === 'io') throw result.error;
  return result;
}
const rebuild = (c: Context) => ({ kind: 'rebuild' as const, anchor: { ...c.index.range } });

/** Source/checkpoint/page I/O share the caller's budget. A page is fsynced
 * before the checkpoint advances. A crash between those writes reuses only an
 * identical immutable page; corrupt/incompatible builds request a new version. */
export async function advanceCommitContainerIndex(c: Context, budget: WindowBudget, signal?: AbortSignal) {
  const start = initial(c); signal?.throwIfAborted();
  const loaded = await load(c, null, budget);
  let previous: Head;
  try {
    if (loaded.kind === 'miss' && loaded.reason !== 'not_found') return rebuild(c);
    previous = loaded.kind === 'hit' ? head(c, parse(loaded.bytes)) : { version: 1, pages: 0, state: start };
  } catch { return rebuild(c); }
  if (previous.state.phase === 'done') {
    await assertWindowCommitSource(c.directory, c.binding, c.source); signal?.throwIfAborted();
    return { kind: 'complete' as const, head: previous };
  }
  const result = await readCommitContainerPage(c.directory, c.binding, c.source, previous.state, budget, signal);
  let pages = previous.pages;
  if (result.members.length) {
    const payload: Page = { version: 1, ordinal: pages, members: result.members, next: result.state }, bytes = encode(payload);
    signal?.throwIfAborted();
    try { await writeWindowFrame(c.directory, frame(c, pages), bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const old = await load(c, pages, budget);
      if (old.kind !== 'hit' || !Buffer.from(old.bytes).equals(bytes)) return rebuild(c);
    }
    pages++;
  }
  const next: Head = { version: 1, pages, state: result.state };
  signal?.throwIfAborted();
  await writeWindowFrame(c.directory, frame(c, null), encode(next));
  await assertWindowCommitSource(c.directory, c.binding, c.source);
  signal?.throwIfAborted();
  return { kind: result.complete ? 'complete' as const : 'progress' as const, head: next };
}

/** A completed build is seekable by immutable page ordinal, without walking
 * preceding pages. A source/row receipt is still required above this cache. */
export async function readIndexedCommitContainerPage(c: Context, ordinal: number, budget: WindowBudget, signal?: AbortSignal) {
  initial(c); signal?.throwIfAborted();
  if (!validPosition(ordinal)) throw new RangeError('Invalid container page ordinal');
  const loaded = await load(c, null, budget);
  let h: Head;
  try { if (loaded.kind !== 'hit') return rebuild(c); h = head(c, parse(loaded.bytes)); } catch { return rebuild(c); }
  await assertWindowCommitSource(c.directory, c.binding, c.source);
  signal?.throwIfAborted();
  if (h.state.phase !== 'done') return { kind: 'pending' as const };
  if (ordinal >= h.pages) return { kind: 'end' as const };
  const loadedPage = await load(c, ordinal, budget);
  let p: Page;
  try {
    if (loadedPage.kind !== 'hit') return rebuild(c);
    p = page(c, parse(loadedPage.bytes), ordinal);
    if (p.next.ordinal > h.state.ordinal) return rebuild(c);
  } catch { return rebuild(c); }
  await assertWindowCommitSource(c.directory, c.binding, c.source); signal?.throwIfAborted();
  return { kind: 'page' as const, page: p, next: ordinal + 1 < h.pages ? ordinal + 1 : null };
}
