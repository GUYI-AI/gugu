import { describe, expect, it, vi } from 'vitest';
import type { WindowProjectionApi } from '@gugu/session-wire/session-window-projection';
import { materializeCommittedTurn } from './acp-window-projection';

const owner = { conversationId: 'conversation', subscriptionId: 'subscription' };
const position = { projectionId: 'source/projection', rowId: 'row', storedSeq: 4, referenceId: 'ref-4' };
const lease = '00000000-0000-4000-8000-000000000004';
const h = (name: string) => `${name}-${'h'.repeat(40)}`;
const ok = <T>(value: T) => ({ ok: true as const, value });

type Page = { entityId: string; parent: string | null; target?: 'item' | 'terminal'; values: Record<string, unknown>;
  fields?: { field: string; kind: 'string' | 'array' | 'object'; handle: string }[]; bodies?: { field: string; handle: string }[]; hasChildren?: boolean };

function host(pages: Page[], fields: Record<string, unknown>, root: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api: WindowProjectionApi = {
    read: vi.fn(async input => {
      calls.push(input.kind);
      if (input.kind === 'open') return ok({ lease, position: { ...position }, count: pages.length, next: pages.length ? h('page-0') : null,
        root: { target: 'turn', values: { id: 'turn-4', seq: 4, referenceId: 'ref-4', initiator: 'user', 'outcome.kind': 'done', ...root }, fields: [] } });
      if (input.kind === 'page') {
        const ordinal = Number(input.cursor.split('-')[1]);
        const page = pages[ordinal];
        return ok({ lease, position: { ...position }, ordinal, entityId: page.entityId, parentEntityId: page.parent, hasChildren: !!page.hasChildren,
          header: { target: page.target ?? 'item', values: page.values, fields: page.fields ?? [] }, bodies: page.bodies ?? [],
          next: ordinal + 1 < pages.length ? h(`page-${ordinal + 1}`) : null });
      }
      return ok(undefined);
    }) as WindowProjectionApi['read'],
    readBody: vi.fn(async input => ok(fields[input.handle])) as WindowProjectionApi['readBody'],
  };
  return { api, calls };
}

describe('committed turn materialization', () => {
  it('rebuilds nested items, paged bodies, deferred containers and terminals from the projection only', async () => {
    const { api, calls } = host([
      { entityId: 'e-msg', parent: null, values: { id: 'msg', seq: 0, kind: 'message', role: 'assistant' }, bodies: [{ field: 'text', handle: h('text-a') }] },
      { entityId: 'e-group', parent: null, hasChildren: true, values: { id: 'group', seq: 1, kind: 'tool-group', label: 'Edits', groupKind: 'read-batch', status: 'done' } },
      { entityId: 'e-exec', parent: 'e-group', values: { id: 'exec', seq: 2, kind: 'execute-tool-call', toolCallId: 'call', title: 'ls', status: 'done', 'exitStatus.exitCode': 0, 'exitStatus.signal': null },
        fields: [{ field: 'locations', kind: 'array', handle: h('locations') }], bodies: [{ field: 'outputText', handle: h('out') }] },
      { entityId: 'e-term', parent: null, target: 'terminal', values: { terminalId: 'term', owner: 'agent', canKill: false, truncated: false, command: 'ls', cwd: '/tmp', 'exitStatus.exitCode': 0, 'exitStatus.signal': null },
        fields: [{ field: 'args', kind: 'array', handle: h('args') }], bodies: [{ field: 'output', handle: h('term-out') }] },
    ], {
      [h('text-a')]: { kind: 'body', offset: 0, text: '你好, ', next: h('text-b') },
      [h('text-b')]: { kind: 'body', offset: 8, text: 'world', next: null },
      [h('out')]: { kind: 'body', offset: 0, text: 'a\nb', next: null },
      [h('locations')]: { kind: 'values', containerKind: 'array', next: null, entries: [
        { ordinal: 0, key: null, value: { kind: 'field', fieldKind: 'object', handle: h('loc-0') } }] },
      [h('loc-0')]: { kind: 'values', containerKind: 'object', next: null, entries: [
        { ordinal: 0, key: h('key-path'), value: { kind: 'field', fieldKind: 'string', handle: h('path') } },
        { ordinal: 1, key: h('key-line'), value: { kind: 'scalar', value: 3 } }] },
      [h('key-path')]: { kind: 'body', offset: 0, text: 'path', next: null },
      [h('key-line')]: { kind: 'body', offset: 0, text: 'line', next: null },
      [h('path')]: { kind: 'body', offset: 0, text: '/tmp/a', next: null },
      [h('args')]: { kind: 'values', containerKind: 'array', next: null, entries: [{ ordinal: 0, key: null, value: { kind: 'field', fieldKind: 'string', handle: h('arg-0') } }] },
      [h('arg-0')]: { kind: 'body', offset: 0, text: '-la', next: null },
      [h('term-out')]: { kind: 'body', offset: 0, text: 'file', next: null },
    });
    const turn = await materializeCommittedTurn(api, owner, position, () => true);
    expect(turn).toMatchObject({ id: 'turn-4', seq: 4, referenceId: 'ref-4', initiator: 'user', outcome: { kind: 'done' },
      terminals: [{ terminalId: 'term', owner: 'agent', args: ['-la'], output: 'file' }] });
    expect(turn.items).toMatchObject([
      { id: 'msg', kind: 'message', text: '你好, world' },
      { id: 'group', kind: 'tool-group', children: [{ id: 'exec', outputText: 'a\nb', exitStatus: { exitCode: 0 }, locations: [{ path: '/tmp/a', line: 3 }] }] },
    ]);
    expect(calls).toEqual(['open', 'page', 'page', 'page', 'page', 'release']);
  });

  it('rejects a body page that does not continue at the decoded offset, and still releases the version', async () => {
    const { api, calls } = host([
      { entityId: 'e-msg', parent: null, values: { id: 'msg', seq: 0, kind: 'message', role: 'assistant' }, bodies: [{ field: 'text', handle: h('text-a') }] },
    ], {
      [h('text-a')]: { kind: 'body', offset: 0, text: 'abc', next: h('text-b') },
      [h('text-b')]: { kind: 'body', offset: 2, text: 'd', next: null },
    });
    await expect(materializeCommittedTurn(api, owner, position, () => true)).rejects.toMatchObject({ code: 'invalid_projection' });
    await vi.waitFor(() => expect(calls.at(-1)).toBe('release'));
  });

  it('rejects a child that arrives before its parent instead of attaching it elsewhere', async () => {
    const { api } = host([
      { entityId: 'e-exec', parent: 'e-group', values: { id: 'exec', seq: 2, kind: 'execute-tool-call', toolCallId: 'call', title: 'ls', status: 'done' } },
    ], {});
    await expect(materializeCommittedTurn(api, owner, position, () => true)).rejects.toMatchObject({ code: 'invalid_projection' });
  });

  it('rejects a root whose reference differs from the committed position', async () => {
    const { api } = host([], {}, { referenceId: 'other' });
    await expect(materializeCommittedTurn(api, owner, position, () => true)).rejects.toMatchObject({ code: 'invalid_projection' });
  });

  it('passes host failures through and stops when the view is released', async () => {
    const failing: WindowProjectionApi = {
      read: vi.fn(async () => ({ ok: false as const, error: { code: 'needs_location', message: 'The requested projection is unavailable' } })),
      readBody: vi.fn(),
    };
    await expect(materializeCommittedTurn(failing, owner, position, () => true)).rejects.toMatchObject({ code: 'needs_location' });
    const { api } = host([], {});
    await expect(materializeCommittedTurn(api, owner, position, () => false)).rejects.toMatchObject({ code: 'unsubscribed' });
    expect(api.read).not.toHaveBeenCalled();
  });
});
