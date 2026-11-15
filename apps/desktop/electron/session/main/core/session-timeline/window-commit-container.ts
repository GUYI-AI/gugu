import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createCommitJsonState, resumeCommitJsonState, scanCommitJson, type CommitJsonState, type CommitJsonToken } from './window-commit-json';
import { assertWindowCommitSource, readWindowCommitSourceChunk, type writeWindowCommitSource, type WindowCommitSourceManifest } from './window-commit-source';

type Range = { start: number; end: number };
type Kind = 'object' | 'array';
type Phase = 'open' | 'key' | 'colon' | 'value' | 'nested' | 'separator' | 'done';
export type CommitContainerState = {
  version: 1; sourceHash: string; range: Range; kind: Kind; phase: Phase; allowEnd: boolean; ordinal: number;
  lex: CommitJsonState; key: Range | null; pending: { kind: Kind; start: number; depth: number } | null;
};
export type CommitContainerMember = { ordinal: number; key: Range | null; range: Range } &
  ({ kind: 'primitive'; value: number | boolean | null } | { kind: 'string' | Kind });
const position = (n: number) => Number.isSafeInteger(n) && n >= 0;
const validRange = (r: Range) => r && position(r.start) && position(r.end) && r.end > r.start;
const open = (kind: Kind) => kind === 'object' ? '{' : '[';
const close = (kind: Kind) => kind === 'object' ? '}' : ']';

export function createCommitContainerState(source: WindowCommitSourceManifest, range: Range, kind: Kind): CommitContainerState {
  return resumeCommitContainerState({ version: 1, sourceHash: source.sha256, range, kind, phase: 'open', allowEnd: true,
    ordinal: 0, lex: createCommitJsonState(range.start), key: null, pending: null }, source);
}

/** A single container's immediate children, not a retained recursive AST.
 * Nested values are opaque ranges; their own members can be read independently. */
export function resumeCommitContainerState(input: unknown, source: WindowCommitSourceManifest): CommitContainerState {
  const s = input as CommitContainerState;
  if (!s || s.version !== 1 || !/^[a-f0-9]{64}$/.test(s.sourceHash) || s.sourceHash !== source.sha256 || !validRange(s.range)
    || s.range.end > source.bytes || !['object', 'array'].includes(s.kind)
    || !['open', 'key', 'colon', 'value', 'nested', 'separator', 'done'].includes(s.phase)
    || typeof s.allowEnd !== 'boolean' || !position(s.ordinal)) throw new Error('Invalid commit container checkpoint');
  const lex = resumeCommitJsonState(s.lex);
  if (lex.offset < s.range.start || lex.offset > s.range.end || lex.start < s.range.start || s.ordinal > lex.offset - s.range.start
    || (s.phase === 'open' && (lex.offset !== s.range.start || s.ordinal !== 0))
    || (s.phase === 'done' && lex.offset !== s.range.end)
    || (s.key !== null && (!validRange(s.key) || s.kind !== 'object' || s.key.start <= s.range.start || s.key.end > lex.offset))
    || (s.kind === 'object' && ['colon', 'value', 'nested'].includes(s.phase) !== (s.key !== null))
    || (s.kind === 'array' && ['key', 'colon'].includes(s.phase))
    || (s.phase === 'nested') !== (s.pending !== null)) throw new Error('Invalid commit container state');
  const p = s.pending;
  if (p && (!['object', 'array'].includes(p.kind) || !position(p.start) || p.start <= s.range.start || p.start >= lex.offset
    || !position(p.depth) || p.depth < 1 || p.depth > lex.offset - p.start)) throw new Error('Invalid nested commit range');
  return { version: 1, sourceHash: s.sourceHash, range: { ...s.range }, kind: s.kind, phase: s.phase,
    allowEnd: s.allowEnd, ordinal: s.ordinal, lex, key: s.key && { ...s.key }, pending: p && { kind: p.kind, start: p.start, depth: p.depth } };
}

function consume(s: CommitContainerState, token: CommitJsonToken, members: CommitContainerMember[]): void {
  const punctuation = token.kind === 'punctuation' ? token.value : null;
  const finish = (range: Range, value: { kind: 'primitive'; value: number | boolean | null } | { kind: 'string' | Kind }) => {
    members.push({ ordinal: s.ordinal++, key: s.key, range, ...value });
    s.key = null; s.pending = null; s.phase = 'separator'; s.allowEnd = true;
  };
  const end = () => {
    if (token.end !== s.range.end) throw new SyntaxError('Commit container range mismatch');
    s.phase = 'done';
  };
  if (s.phase === 'open') {
    if (punctuation !== open(s.kind) || token.start !== s.range.start) throw new SyntaxError('Commit container opener mismatch');
    s.phase = s.kind === 'object' ? 'key' : 'value';
  } else if (s.phase === 'nested') {
    const pending = s.pending!;
    if (punctuation === '{' || punctuation === '[') pending.depth++;
    else if (punctuation === '}' || punctuation === ']') {
      if (pending.depth === 1 && punctuation !== close(pending.kind)) throw new SyntaxError('Commit nested closer mismatch');
      if (--pending.depth === 0) finish({ start: pending.start, end: token.end }, { kind: pending.kind });
    }
  } else if ((s.phase === 'key' || s.phase === 'value') && punctuation === close(s.kind) && s.allowEnd) end();
  else if (s.phase === 'key') {
    if (token.kind !== 'string') throw new SyntaxError('Commit object needs a string key');
    s.key = { start: token.start - 1, end: token.end + 1 }; s.phase = 'colon';
  } else if (s.phase === 'colon') {
    if (punctuation !== ':') throw new SyntaxError('Commit object needs a colon');
    s.phase = 'value'; s.allowEnd = false;
  } else if (s.phase === 'value') {
    if (token.kind === 'string') finish({ start: token.start - 1, end: token.end + 1 }, { kind: 'string' });
    else if (token.kind === 'primitive') finish({ start: token.start, end: token.end }, { kind: 'primitive', value: token.value });
    else if (punctuation === '{' || punctuation === '[') {
      s.pending = { kind: punctuation === '{' ? 'object' : 'array', start: token.start, depth: 1 }; s.phase = 'nested';
    } else throw new SyntaxError('Commit container needs a value');
  } else if (s.phase === 'separator') {
    if (punctuation === close(s.kind)) end();
    else if (punctuation === ',') { s.phase = s.kind === 'object' ? 'key' : 'value'; s.allowEnd = false; }
    else throw new SyntaxError('Commit container needs a separator');
  } else throw new SyntaxError('Unexpected token after commit container');
}

/** Each step reads at most two 16KiB physical source frames and returns at
 * most one token batch's children (<=16). A giant nested value/string yields
 * progress with a constant-size checkpoint. No canonical data column is read.
 * Nested contents remain opaque canonical values, not independently validated ASTs. */
export async function readCommitContainerPage(directory: string, binding: Parameters<typeof writeWindowCommitSource>[1],
  source: WindowCommitSourceManifest, input: CommitContainerState, budget: WindowBudget, signal?: AbortSignal) {
  const state = resumeCommitContainerState(input, source), members: CommitContainerMember[] = [];
  let loaded = -1, frames = 0, bytes: Uint8Array = new Uint8Array(0);
  while (!members.length && state.phase !== 'done') {
    signal?.throwIfAborted();
    if (state.lex.offset === state.range.end) throw new SyntaxError('Incomplete commit container');
    const ordinal = Math.floor(state.lex.offset / 16384);
    if (loaded !== ordinal) {
      if (frames === 2) break;
      bytes = await readWindowCommitSourceChunk(directory, binding, source, ordinal, budget, signal); loaded = ordinal; frames++;
    }
    const at = state.lex.offset % 16384, span = bytes.subarray(at, Math.min(bytes.length, state.range.end - ordinal * 16384));
    const tokens = scanCommitJson(state.lex, span, state.lex.offset, state.lex.offset + span.length === state.range.end);
    for (const token of tokens) consume(state, token, members);
  }
  for (const _member of members) budget.charge('examinedRecords', 1);
  await assertWindowCommitSource(directory, binding, source); signal?.throwIfAborted();
  return { state, members, complete: state.phase === 'done' };
}
