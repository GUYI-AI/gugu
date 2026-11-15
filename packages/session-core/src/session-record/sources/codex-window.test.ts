import { describe, expect, it } from 'vitest';
import { decodeCodexWindowRecord } from './codex-jsonl';
describe('Codex bounded window decoding', () => {
  it('decodes the same native record with an explicit append-stable key without ordinal state', () => {
    const record = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'tail' }] } };
    const first = decodeCodexWindowRecord(record, 'source:8589934592');
    expect(first).toMatchObject([{ key: 'source:8589934592', event: { kind: 'message', text: 'tail' } }]);
    expect(decodeCodexWindowRecord({ ...record, payload: { ...record.payload, id: 'resume-renumbered' } }, 'source:8589934592')).toEqual(first);
  });
  it('keeps an out-of-window tool result addressable by its native call ID', () => {
    const record = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-before-window', output: 'result' } };
    expect(decodeCodexWindowRecord(record, 'source:9000')).toMatchObject([{ key: 'source:9000', event: { toolCallId: 'call-before-window' } }]);
  });
  it('accepts known steering explicitly and does not infer it from a tail-local ordinal', () => {
    const record = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'follow-up' }] } };
    expect(decodeCodexWindowRecord(record, 'source:10', true)).toMatchObject([{ event: { steering: true } }]);
    expect(decodeCodexWindowRecord(record, 'source:10')[0].event).not.toHaveProperty('steering');
  });
});
