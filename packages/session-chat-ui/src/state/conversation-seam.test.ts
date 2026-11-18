import { textFilePatch } from '@gugu/session-core/lib';
import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, Margin, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { describe, expect, it } from 'vitest';
import { trailingActivity } from './agent-activity';
import { lastConversationMessage } from './conversation-density';
import { flattenTier } from './flatten';

// A full rebuild and the committed-to-live append must measure the same utterance boundary.
const KINDS = ['message', 'turn-process', 'tool-run', 'execute-tool-call', 'mcp-tool-call', 'diff', 'file-change-summary', 'opened-output', 'conversation-process-steps', 'turn-completion'];
const SEGMENTERS: Record<string, ItemSegmenter> = Object.fromEntries(KINDS.map(kind => [kind,
  { kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] } satisfies ItemSegmenter]));
const MARGINS: Record<string, { margin: Margin }> = {
  message: { margin: { top: 8, bottom: 8 } }, 'turn-process': { margin: { top: 4, bottom: 4 } },
  'tool-run': { margin: { top: 2, bottom: 2 } }, 'file-change-summary': { margin: { top: 8, bottom: 8 } },
  'opened-output': { margin: { top: 0, bottom: 0 } }, 'conversation-process-steps': { margin: { top: 0, bottom: 0 } },
};
const ctx = (expandedProcess = false): SegmentCtx => ({ caches: {}, expanded: () => false, active: false, plan: () => null,
  translate: defaultChatTranslator, pendingToolCallIds: () => new Set<string>(), terminalSnapshot: () => null,
  foldTurnProcess: true, agentConversation: true, isTurnProcessExpanded: () => expandedProcess } as unknown as SegmentCtx);

const user = (id: string): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user', text: id });
const reply = (id: string): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'assistant', text: id });
const bash = (id: string): ChatItem => ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'bash', status: 'done' } as unknown as ChatItem);
const edit = (id: string, path: string): ChatItem => ({ kind: 'diff', id, patches: [textFilePatch(path, 'a', 'b')], status: 'done' } as unknown as ChatItem);
const open = (id: string, path: string): ChatItem => ({ kind: 'mcp-tool-call', id, seq: 0, toolCallId: id, title: 'mcp__gugu__session_open_in_tab',
  server: 'gugu', tool: 'session_open_in_tab', status: 'done', rawInput: JSON.stringify({ path }),
  outputText: JSON.stringify({ opened: true, path, intent: 'pinned' }), parentToolCallId: null } as unknown as ChatItem);
const turn = (id: string, items: ChatItem[]): TranscriptTurn => ({ id, seq: 1, initiator: 'user', startedAt: 1000, endedAt: 9000,
  items: items as TranscriptTurn['items'], outcome: { kind: 'done' } } as TranscriptTurn);

/** The next user message's gapBefore, flattened together with the turn before it and appended after it. */
function seam(first: TranscriptTurn, expandedProcess = false): { rebuilt: number; appended: number; lastKind: string } {
  const next = turn('t2', [user('next')]);
  const rebuilt = flattenTier([first, next], ctx(expandedProcess), SEGMENTERS, MARGINS);
  const head = flattenTier([first], ctx(expandedProcess), SEGMENTERS, MARGINS);
  const tail = flattenTier([next], ctx(expandedProcess), SEGMENTERS, MARGINS, head.at(-1)?.kind, undefined,
    lastConversationMessage(head), trailingActivity(head), head.at(-1));
  const gap = (units: typeof rebuilt) => units.find(u => u.itemId === 'next')!.gapBefore;
  return { rebuilt: gap(rebuilt), appended: gap(tail), lastKind: head.at(-1)!.kind };
}

describe('the user message after a turn has the same gap appended as rebuilt', () => {
  it.each([
    ['an "edited files" card', turn('t1', [user('u'), edit('e1', '/p/a.txt'), edit('e2', '/p/b.txt'), reply('r')]), false, 'turn-completion'],
    ['an opened-output card', turn('t1', [user('u'), open('o', '/p/report.md'), reply('r')]), false, 'turn-completion'],
    ['the agent bubble', turn('t1', [user('u'), bash('b'), reply('r')]), false, 'message'],
    ['completion after expanded process steps', turn('t1', [user('u'), bash('b')]), true, 'turn-completion'],
    ['completion after a collapsed process', turn('t1', [user('u'), bash('b')]), false, 'turn-completion'],
  ])('after %s', (_name, first, expandedProcess, lastKind) => {
    const { rebuilt, appended, lastKind: last } = seam(first, expandedProcess);
    expect(last, 'the fixture does not end the turn on the row it names').toBe(lastKind);
    expect(appended).toBe(rebuilt);
    expect(rebuilt).toBe(24);
  });
});
