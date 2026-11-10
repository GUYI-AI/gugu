import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createWindowCommitReader } from './window-commit-reader';
import { createCommitContainerState, readCommitContainerPage, resumeCommitContainerState, type CommitContainerState } from './window-commit-container';
import type { WindowCommitReceipt } from './window-commit-receipt';

export type ProjectionFieldPosition = { kind: 'string' | 'array' | 'object'; range: { start: number; end: number };
  offset?: { rawOffset: number; decodedOffset: number }; container?: CommitContainerState };

/** Exactly one bounded string or immediate-container page. Nested values stay
 * private capabilities, not a recursive AST or unbounded JSON.parse. */
export async function readProjectionField(directory: string, receipt: WindowCommitReceipt, input: ProjectionFieldPosition,
  budget: WindowBudget, signal?: AbortSignal) {
  const range = { start: input.range.start, end: input.range.end }, kind = input.kind;
  if (!['string', 'array', 'object'].includes(kind) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start + 1 || range.end > receipt.source.bytes) throw new Error('Invalid projection field range');
  if (kind === 'string') {
    const reader = createWindowCommitReader(directory, receipt.binding, receipt.source, budget, signal);
    try {
      const position = input.offset ? { ...input.offset } : { rawOffset: range.start + 1, decodedOffset: 0 };
      const body = await reader.string({ start: range.start + 1, end: range.end }, position, 16384);
      budget.charge('outputBytes', Buffer.byteLength(body.text));
      return { kind: 'body' as const, offset: position.decodedOffset, text: body.text, complete: body.complete,
        next: { kind, range, offset: body.next } satisfies ProjectionFieldPosition };
    } finally { reader.close(); }
  }
  const state = input.container ? resumeCommitContainerState(input.container, receipt.source) : createCommitContainerState(receipt.source, range, kind);
  if (state.kind !== kind || state.range.start !== range.start || state.range.end !== range.end) throw new Error('Projection field continuation mismatch');
  const result = await readCommitContainerPage(directory, receipt.binding, receipt.source, state, budget, signal);
  // Keys, including gigantic keys, are field capabilities too. Their content
  // is never decoded merely to enumerate a structured metadata page.
  return { kind: 'values' as const, containerKind: kind, members: result.members.map(member => ({ ordinal: member.ordinal,
    key: member.key ? { kind: 'string' as const, range: { ...member.key } } : null,
    value: member.kind === 'primitive' ? { kind: 'scalar' as const, value: member.value }
      : { kind: 'field' as const, position: { kind: member.kind, range: { ...member.range } } } })),
    complete: result.complete, next: { kind, range, container: result.state } satisfies ProjectionFieldPosition };
}
