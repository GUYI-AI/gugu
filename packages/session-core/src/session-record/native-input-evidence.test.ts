import { describe, expect, it } from 'vitest';
import { mergeDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { inspectNativeInputTail } from './native-input-evidence';
import { WINDOW_FRAME_BYTES } from './window-cache/byte-page';
import type { SourceSnapshot, WindowByteSource } from './window-cache/types';
import { meteredSource } from '../../../../tests/helpers/native-history-io';

const locator = { harness: 'codex' as const, providerSessionId: 'native-session' };
const envelope = (id = 'source-id') => renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromType: 'agent',
  fromId: 'session:sender', messageId: `msg:${id}`, at: 'now', content: 'work' });
const input = { id: 'host-client-id', text: envelope() };
const meta = { type: 'session_meta', payload: { id: locator.providerSessionId } };
const user = (text: string, role = 'user') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');

function source(text: string, size = Buffer.byteLength(text)) {
  const suffix = Buffer.from(text);
  let snapshot: SourceSnapshot = { sourceId: 'record', sourceInstance: 'inode', snapshotRevision: 'revision', size };
  const api: WindowByteSource = { snapshot: async () => ({ ...snapshot }), async read(target, offset, length, position) {
    target.fill(120, offset, offset + length);
    const start = Math.max(position, size - suffix.length), end = Math.min(position + length, size);
    if (end > start) target.set(suffix.subarray(start - size + suffix.length, end - size + suffix.length), offset + start - position);
    return length;
  } };
  return { api, change(value: Partial<SourceSnapshot>) { snapshot = { ...snapshot, ...value }; } };
}

describe('native input evidence after an admission timeout', () => {
  it('recognizes a real user input independently of the missing host projection', async () => {
    const tail = await inspectNativeInputTail(source(jsonl(meta, user(input.text))).api, locator);
    expect(tail.find(input)).toMatchObject({ state: 'received' });
    expect(tail.find({ id: 'other', text: envelope('missing') })).toEqual({ state: 'absent', reason: 'native_input_absent' });
  });

  it('does not acknowledge assistant quotes, tool results, reply targets or a partial batch', async () => {
    const quote = envelope('other').replace('<![CDATA[', '<reply_to msg="msg:source-id" from_id="session:sender"><![CDATA[quote]]></reply_to><![CDATA[');
    const tail = await inspectNativeInputTail(source(jsonl(meta, user(input.text, 'assistant'),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: input.text } }, user(quote), user(envelope('one')))).api, locator);
    expect(tail.find(input)).toMatchObject({ state: 'absent' });
    expect(tail.find({ id: 'batch', text: mergeDeliveryEnvelopes([envelope('one'), envelope('two')]) })).toMatchObject({ state: 'absent' });
  });

  it.each([2, 5, 20])('reads just one 64 KiB suffix of a virtual %i GiB record, never its poison prefix', async gib => {
    const size = gib * 1024 ** 3 + 17;
    const native = source('\n' + jsonl(user(input.text)), size);
    const measured = meteredSource(native.api, { bytes: WINDOW_FRAME_BYTES, buffer: WINDOW_FRAME_BYTES, earliest: size - WINDOW_FRAME_BYTES, calls: 1 });
    const tail = await inspectNativeInputTail(measured.source, locator);
    expect(tail.find(input)).toMatchObject({ state: 'received' });
    expect(tail.find({ id: 'missing', text: envelope('missing') })).toEqual({ state: 'incomplete', reason: 'native_tail_does_not_cover_history' });
    expect(measured.counts.bytes).toBe(WINDOW_FRAME_BYTES);
    expect(measured.counts.calls).toBe(1);
  });

  it.each(['sourceInstance', 'snapshotRevision', 'size'] as const)('invalidates a matching user record when %s changes during the read', async field => {
    const native = source(jsonl(meta, user(input.text)));
    const read = native.api.read;
    native.api.read = async (...args) => { const n = await read(...args); native.change(field === 'size' ? { size: 9000 } : { [field]: 'changed' }); return n; };
    expect((await inspectNativeInputTail(native.api, locator)).find(input)).toEqual({ state: 'incomplete', reason: 'native_source_changed' });
  });

  it('rejects a late append during decoding, not just a write during the physical read', async () => {
    const native = source(jsonl(meta, user(input.text)));
    let snapshots = 0;
    const snapshot = native.api.snapshot;
    native.api.snapshot = async () => { if (++snapshots === 3) native.change({ snapshotRevision: 'late-write' }); return snapshot(); };
    expect((await inspectNativeInputTail(native.api, locator)).find(input)).toEqual({ state: 'incomplete', reason: 'native_source_changed' });
  });

  it('keeps partial trailing records, corrupt JSON and identity-free text explicitly unresolved', async () => {
    expect((await inspectNativeInputTail(source(jsonl(meta) + JSON.stringify(user(input.text))).api, locator)).find(input))
      .toEqual({ state: 'incomplete', reason: 'native_record_incomplete' });
    expect((await inspectNativeInputTail(source(jsonl(meta) + '{broken}\n').api, locator)).find(input))
      .toEqual({ state: 'incomplete', reason: 'native_record_invalid' });
    expect((await inspectNativeInputTail(source(jsonl(meta, user('same prose'))).api, locator)).find({ id: 'host', text: 'same prose' }))
      .toEqual({ state: 'incomplete', reason: 'native_input_identity_unavailable' });
  });

  it('prioritizes recent records within the shared decoded-record budget and never labels an uncovered prefix absent', async () => {
    const rows = Array.from({ length: 150 }, () => ({ type: 'event_msg', payload: { type: 'token_count' } }));
    const tail = await inspectNativeInputTail(source(jsonl(meta, ...rows, user(input.text))).api, locator);
    expect(tail.find(input)).toMatchObject({ state: 'received' });
    expect(tail.find({ id: 'missing', text: envelope('missing') })).toEqual({ state: 'incomplete', reason: 'native_read_budget_exhausted' });
  });

  it('checks Claude user identity and refuses a foreign native session', async () => {
    const claude = { type: 'user', sessionId: 'claude-native', uuid: 'native-input', message: { role: 'user', content: input.text } };
    expect((await inspectNativeInputTail(source(jsonl(claude)).api, { harness: 'claude', providerSessionId: 'claude-native' })).find(input))
      .toEqual({ state: 'received', nativeReceiptId: 'native-input' });
    expect((await inspectNativeInputTail(source(jsonl(claude)).api, { harness: 'claude', providerSessionId: 'other' })).find(input))
      .toEqual({ state: 'incomplete', reason: 'native_session_changed' });
  });
});
