import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  WINDOW_PROJECTION_BODY_BYTES, windowProjectionBodyReadRequestSchema, windowProjectionBodyReadResultSchema,
  windowProjectionFieldPageSchema, windowProjectionHandleSchema, windowProjectionHeaderSchema,
  windowProjectionOpenSchema, windowProjectionPageSchema, windowProjectionReadRequestSchema,
  windowProjectionReadResultSchema, type WindowProjectionApi, type WindowProjectionFieldPage,
} from './session-window-projection';
import type { WindowLiveResult } from './session-window-live';

const owner = { conversationId: 'conversation', subscriptionId: 'subscription' };
const handle = 'A'.repeat(64), lease = 'bf8059cf-e54a-46bf-a42c-b9ae275e150f';
const position = { rowId: 'c:0', storedSeq: 0, referenceId: 'ref', projectionId: 'source/version' };
const header = () => ({ target: 'turn', values: { id: 'turn', seq: 0, referenceId: 'ref', initiator: 'agent',
  'outcome.kind': 'error', 'outcome.reason': 'process_closed' }, fields: [{ field: 'outcome.detail', kind: 'string', handle }] });
const opened = () => ({ lease, position, root: header(), count: 2, next: handle });
const row = () => ({ lease, position, ordinal: 0, entityId: 'entity', parentEntityId: null,
  header: { target: 'item', values: { id: 'tool', seq: 4, kind: 'mcp-tool-call', toolCallId: 'provider-call',
    title: 'Read', status: 'done', tool: 'read', parentToolCallId: 'provider-parent' }, fields: [{ field: 'locations', kind: 'array', handle }] },
  hasChildren: false, bodies: [{ field: 'rawInput', handle }, { field: 'rawOutput', handle }], next: handle });
const body = (text = '中文😀') => ({ kind: 'body', offset: 0, text, next: handle });
const values = (count = 1) => ({ kind: 'values', containerKind: 'object', entries: Array.from({ length: count }, (_, ordinal) => ({ ordinal,
  key: handle, value: { kind: 'field', fieldKind: 'string', handle } })), next: handle });

describe('bounded projection public contract', () => {
  it('preserves owner and version coordinates on the three projection operations', () => {
    for (const input of [{ ...owner, kind: 'open', position }, { ...owner, kind: 'page', cursor: handle }, { ...owner, kind: 'release', lease }]) {
      expect(windowProjectionReadRequestSchema.parse(input)).toEqual(input);
      expect(windowProjectionReadRequestSchema.safeParse({ ...input, subscriptionId: undefined }).success).toBe(false);
    }
    expect(windowProjectionBodyReadRequestSchema.parse({ ...owner, handle })).toEqual({ ...owner, handle });
    expect(windowProjectionReadRequestSchema.safeParse({ ...owner, kind: 'open', position: { ...position, kind: 'insert' } }).success).toBe(false);
  });
  it('accepts actual host open and row shapes without manufacturing rendering facts', () => {
    expect(windowProjectionOpenSchema.parse(opened())).toEqual(opened());
    const parsed = windowProjectionPageSchema.parse(row());
    expect(parsed).toEqual(row()); expect(parsed.header.values).not.toHaveProperty('completedAt');
    expect(parsed.parentEntityId).toBeNull(); expect(parsed.header.values.parentToolCallId).toBe('provider-parent');
    expect(windowProjectionOpenSchema.safeParse({ ...opened(), count: 0, next: null }).success).toBe(true);
    expect(windowProjectionOpenSchema.safeParse({ ...opened(), count: 0 }).success).toBe(false);
    expect(windowProjectionOpenSchema.safeParse({ ...opened(), position: { ...position, referenceId: 'another' } }).success).toBe(false);
  });
  it('keeps structured values bounded and strings behind opaque field capabilities', () => {
    expect(windowProjectionFieldPageSchema.parse(values(16))).toEqual(values(16));
    expect(windowProjectionFieldPageSchema.safeParse(values(17)).success).toBe(false);
    for (const value of [null, false, 17]) {
      const page = { ...values(), containerKind: 'array', entries: [{ ordinal: 0, key: null, value: { kind: 'scalar', value } }] };
      expect(windowProjectionFieldPageSchema.parse(page)).toEqual(page);
    }
    for (const value of ['inline content', [], {}, Infinity]) {
      expect(windowProjectionFieldPageSchema.safeParse({ ...values(), containerKind: 'array', entries: [{ ordinal: 0, key: null, value: { kind: 'scalar', value } }] }).success).toBe(false);
    }
    expect(windowProjectionFieldPageSchema.safeParse({ ...values(2), entries: [values().entries[0], values().entries[0]] }).success).toBe(false);
  });
  it.each(['array', 'object'])('preserves a real empty %s and rejects the old kind-less shape', containerKind => {
    const page = { ...values(0), containerKind, next: null };
    expect(windowProjectionFieldPageSchema.parse(page)).toEqual(page);
    expect(windowProjectionFieldPageSchema.safeParse({ ...page, containerKind: undefined }).success).toBe(false);
  });
  it('keeps nested field kinds and array/object key semantics distinct', () => {
    for (const fieldKind of ['string', 'array', 'object']) {
      const page = { ...values(), entries: [{ ordinal: 0, key: handle, value: { kind: 'field', fieldKind, handle } }] };
      expect(windowProjectionFieldPageSchema.parse(page)).toEqual(page);
      expect(windowProjectionFieldPageSchema.safeParse({ ...page, entries: [{ ...page.entries[0], value: { kind: 'field', handle } }] }).success).toBe(false);
      expect(windowProjectionFieldPageSchema.safeParse({ ...page, containerKind: 'array' }).success).toBe(false);
    }
  });
  it('uses UTF8 bytes for body pages, with exact ASCII, CJK and emoji boundaries', () => {
    for (const text of ['a'.repeat(WINDOW_PROJECTION_BODY_BYTES), '界'.repeat(5461) + 'a', '😀'.repeat(4096)]) {
      expect(windowProjectionFieldPageSchema.parse(body(text))).toEqual(body(text));
      expect(windowProjectionFieldPageSchema.safeParse(body(text + 'a')).success).toBe(false);
    }
  });
  it.each(['text', 'stdout', 'input', 'content'])('does not alias a tool body into the guessed slot %s', field => {
    expect(windowProjectionPageSchema.safeParse({ ...row(), bodies: [{ field, handle }] }).success).toBe(false);
  });
  it('supports only the exact canonical body owner slots and rejects duplicate slots', () => {
    const message = { ...row(), header: { target: 'item', values: { id: 'answer', seq: 9, kind: 'message', role: 'assistant' }, fields: [] }, bodies: [{ field: 'text', handle }] };
    expect(windowProjectionPageSchema.parse(message)).toEqual(message);
    expect(windowProjectionPageSchema.safeParse({ ...message, bodies: [{ field: 'output', handle }] }).success).toBe(false);
    expect(windowProjectionPageSchema.safeParse({ ...row(), bodies: [row().bodies[0], row().bodies[0]] }).success).toBe(false);
    const terminal = { ...row(), header: { target: 'terminal', values: { terminalId: 'terminal', owner: 'tool', canKill: false, truncated: false }, fields: [] }, bodies: [{ field: 'output', handle }] };
    expect(windowProjectionPageSchema.parse(terminal)).toEqual(terminal);
  });
  it('rejects unknown header fields, oversized inline scalars and incomplete identities', () => {
    for (const values of [{ ...header().values, sourceLineage: 'private' }, { ...header().values, id: '界'.repeat(171) },
      { seq: 0, initiator: 'agent' }]) expect(windowProjectionHeaderSchema.safeParse({ ...header(), values }).success).toBe(false);
    expect(windowProjectionHeaderSchema.safeParse({ ...row().header, values: { id: 'bad', seq: 0, kind: 'toString' } }).success).toBe(false);
    for (const field of ['outcome.', 'outcome.detail.extra', 'sourceRange']) {
      expect(windowProjectionHeaderSchema.safeParse({ ...header(), fields: [{ field, kind: 'string', handle }] }).success).toBe(false);
    }
    expect(windowProjectionHeaderSchema.safeParse({ ...header(), fields: [{ field: 'id', kind: 'string', handle }] }).success).toBe(false);
  });
  it.each([
    () => ({ ...opened(), range: { start: 0, end: 10 } }),
    () => ({ ...opened(), root: { ...header(), rawOffset: 0 } }),
    () => ({ ...row(), header: { ...row().header, fields: [{ ...row().header.fields[0], range: { start: 1, end: 2 } }] } }),
  ])('rejects source coordinates at every projection nesting level', make => {
    expect(windowProjectionReadResultSchema.safeParse({ ok: true, value: make() }).success).toBe(false);
  });
  it('rejects private state in field pages and requests', () => {
    expect(windowProjectionFieldPageSchema.safeParse({ ...body(), rawOffset: 10 }).success).toBe(false);
    expect(windowProjectionFieldPageSchema.safeParse({ ...values(), entries: [{ ordinal: 0, key: handle, value: { kind: 'field', fieldKind: 'object', handle, range: { start: 1, end: 2 } } }] }).success).toBe(false);
    expect(windowProjectionBodyReadRequestSchema.safeParse({ ...owner, handle, offset: 16384 }).success).toBe(false);
    for (const value of ['a', 'A'.repeat(2801), 'A'.repeat(63) + '/']) expect(windowProjectionHandleSchema.safeParse(value).success).toBe(false);
  });
  it('preserves typed failures and explicit release without a successful empty fallback', () => {
    const failed = { ok: false, error: { code: 'needs_location', message: 'Version is not published' } };
    expect(windowProjectionReadResultSchema.parse(failed)).toEqual(failed);
    expect(windowProjectionBodyReadResultSchema.parse(failed)).toEqual(failed);
    expect(windowProjectionReadResultSchema.parse({ ok: true, value: undefined })).toEqual({ ok: true, value: undefined });
    expect(windowProjectionBodyReadResultSchema.safeParse({ ok: true, value: undefined }).success).toBe(false);
    expect(windowProjectionReadResultSchema.safeParse({ success: true, data: opened() }).success).toBe(false);
    expectTypeOf<ReturnType<WindowProjectionApi['readBody']>>().toEqualTypeOf<Promise<WindowLiveResult<WindowProjectionFieldPage>>>();
  });
});
