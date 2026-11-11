import { describe, expect, it } from 'vitest';
import { trimCursorPageForTransport, TRANSPORT_PAYLOAD_BUDGET, TRANSPORT_TEXT_LIMIT } from '@gugu/session-core/session-record';
import type { ToolNode, TranscriptTurn } from '@session-chat/model';
import { toolStepDetail } from './tool-step-detail';

// A lean page (transport-trim `step-line`) sends a call without its raw input, on the promise that the step line
// reads the same. This is that promise, held against the function the line is drawn with.
describe('a step line drawn from a lean page', () => {
  const input = JSON.stringify({ url: 'https://example.com/a', depth: 2, body: 'b'.repeat(4_000) });
  const node = (fields: Record<string, unknown>) =>
    ({ id: 'n', seq: 1, toolCallId: 'n', title: 'run', status: 'done', rawInput: input, ...fields }) as unknown as Exclude<ToolNode, { kind: 'tool-group' }>;
  const calls = [
    node({ kind: 'execute-tool-call', command: 'c'.repeat(2_000) }),
    node({ kind: 'execute-tool-call', inputSummary: 'make test' }),
    node({ kind: 'execute-tool-call' }),
    node({ kind: 'execute-tool-call', command: '' }),
    node({ kind: 'read-tool-call', path: '/a/b.ts' }),
    node({ kind: 'read-tool-call', resource: 'gugu://file' }),
    node({ kind: 'read-tool-call' }),
    node({ kind: 'search-tool-call', query: 'needle' }),
    node({ kind: 'search-tool-call' }),
    node({ kind: 'web-fetch-tool-call', url: 'https://example.com' }),
    node({ kind: 'mcp-tool-call', server: 'github', tool: 'search' }),
    node({ kind: 'mcp-tool-call', server: 'github', tool: 'search', inputSummary: '' }),
    node({ kind: 'mcp-tool-call', server: 'gugu', tool: 'message_history', rawInput: '{"chat_id":"c","limit":20}' }),
    node({ kind: 'unknown-tool-call', toolName: 'Skill', rawInput: 'not json  at all' }),
    node({ kind: 'unknown-tool-call', toolName: 'Skill', rawInput: '{}' }),
    node({ kind: 'unknown-tool-call', toolName: 'Skill', rawInput: undefined }),
  ];

  it('reads the same as the line drawn from the whole call', () => {
    const turn = { id: 't', seq: 1, initiator: 'user', items: calls, outcome: null } as unknown as TranscriptTurn;
    const sent = trimCursorPageForTransport({ turns: [turn], nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true).turns[0]!.items as typeof calls;
    expect(sent.every(call => (call as { rawInput?: string }).rawInput === undefined)).toBe(true);
    expect(sent.map(toolStepDetail)).toEqual(calls.map(toolStepDetail));
  });
});
