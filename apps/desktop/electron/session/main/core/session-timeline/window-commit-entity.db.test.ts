import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { advanceCommitContainerIndex, readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { advanceCommitRootFields, createCommitRootState, type CommitRootFacts } from './window-commit-root';
import { advanceCommitEntityFields as advance, commitChildArray, commitEntityIndex, commitRootArray, createCommitEntityState,
  openCommitEntity, type CommitArrayAnchor, type CommitEntityPosition } from './window-commit-entity';
import { readWindowCommitStringPage } from './window-commit-body';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('canonical entity identity and exact body fields', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string, receipt: WindowCommitReceipt, root: CommitRootFacts;
  const huge = 'real tool output 中文😀'.repeat(10000);
  async function build(index: CommitContainerIndex) {
    for (let i = 0; i < 300; i++) {
      const result = await advanceCommitContainerIndex({ directory, binding: receipt.binding, source: receipt.source, index }, createWindowBudget());
      if (result.kind === 'complete') return; expect(result.kind).toBe('progress');
    }
    throw new Error('Entity index did not complete');
  }
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-entity-'));
    const turn: TranscriptTurn = { id: 'runtime:0', seq: 0, referenceId: 'live-ref', initiator: 'user', items: [
      Object.assign({ kind: 'message' as const, id: 'runtime:0:message', seq: 0, role: 'assistant' as const, text: '' }, { rawOutput: 'not a tool body' }),
      { kind: 'thinking', id: 'runtime:0:thinking', seq: 1, segmentId: 'r', status: 'done', startedAt: 1, text: 'actual reasoning' },
      { kind: 'execute-tool-call', id: 'runtime:0:tool:real', seq: 2, toolCallId: 'provider-tool', title: 'Run', status: 'done',
        outputText: huge, rawOutput: 'raw tool result', rawInput: '{"command":"true"}', children: [
          { kind: 'mcp-tool-call', id: 'runtime:0:tool:nested', seq: 3, toolCallId: 'nested', title: 'Nested', status: 'done', tool: 'read', rawOutput: 'nested output' }] },
    ], terminals: [{ terminalId: 'actual-terminal', owner: 'agent', canKill: false, command: 'true', args: [], cwd: '/fixture',
      output: 'actual terminal output', truncated: false, exitStatus: { exitCode: 0, signal: null } }] };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { ...turn, id: 'old', referenceId: 'old-ref', items: [], terminals: [] } });
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn, windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'live-ref')!;
    const index: CommitContainerIndex = { buildId: 'root', kind: 'object', range: { start: 0, end: receipt.source.bytes } };
    await build(index); let cursor = createCommitRootState(receipt, index);
    for (let i = 0; i < 100; i++) {
      const result = await advanceCommitRootFields(directory, receipt, index, cursor, createWindowBudget());
      if (result.kind === 'complete') { root = result.facts; return; }
      if (result.kind !== 'progress') throw new Error('Root unavailable'); cursor = result.state;
    }
    throw new Error('Root fields did not complete');
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
  async function entity(parent: CommitArrayAnchor, member: number, name: string) {
    const array: CommitContainerIndex = { buildId: `${name}-array`, kind: 'array', range: { ...parent.range } };
    await build(array);
    // The production publisher records this real page/member position while
    // enumerating the index. A global entity ordinal is not a page offset.
    let page = 0, selected = -1;
    for (;;) {
      const result = await readIndexedCommitContainerPage({ directory, binding: receipt.binding, source: receipt.source, index: array }, page, createWindowBudget());
      if (result.kind !== 'page') throw new Error('Missing array page');
      selected = result.page.members.findIndex(value => value.ordinal === member);
      if (selected >= 0) break;
      if (result.next === null) throw new Error('Missing entity ordinal'); page = result.next;
    }
    const opened = await openCommitEntity(directory, receipt, parent, array, page, selected, name, createWindowBudget());
    if (opened.kind !== 'position') throw new Error('Entity position unavailable');
    await build(commitEntityIndex(opened.position)); return opened.position;
  }
  async function fields(position: CommitEntityPosition) {
    let cursor = createCommitEntityState(position);
    for (let i = 0; i < 100; i++) {
      const saved = JSON.stringify(cursor), budget = createWindowBudget(), result = await advance(position, cursor, budget);
      expect(JSON.stringify(cursor)).toBe(saved); expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
      if (result.kind === 'complete') return result.facts;
      if (result.kind !== 'progress') throw new Error('Entity fields unavailable'); cursor = JSON.parse(JSON.stringify(result.state)) as typeof cursor;
    }
    throw new Error('Entity fields did not complete');
  }
  async function body(slot: { range: { start: number; end: number } }) {
    return readWindowCommitStringPage(directory, receipt.binding, receipt.source, { range: { start: slot.range.start + 1, end: slot.range.end },
      position: { rawOffset: slot.range.start + 1, decodedOffset: 0 }, maxBytes: 4096, budget: createWindowBudget() });
  }

  it('binds message/thinking/tool slots to the actual non-first canonical entity, preserving empty body and tool kind', async () => {
    const parent = commitRootArray(root, 'item')!;
    const message = await fields(await entity(parent, 0, 'message')), thinking = await fields(await entity(parent, 1, 'thinking'));
    const tool = await fields(await entity(parent, 2, 'tool'));
    expect(message).toMatchObject({ rowId: 'c:1', turnId: 'c:turn:s1', id: 'c:turn:s1:message', kind: 'message' });
    expect(message.slots.map(s => s.field)).toEqual(['text']); expect(await body(message.slots[0])).toMatchObject({ text: '', complete: true });
    expect(thinking.slots.map(s => s.field)).toEqual(['text']); expect(await body(thinking.slots[0])).toMatchObject({ text: 'actual reasoning' });
    expect(tool).toMatchObject({ id: 'c:turn:s1:tool:real', kind: 'execute-tool-call' });
    expect(tool.slots.map(s => s.field)).toEqual(['outputText', 'rawOutput', 'rawInput']);
    const page = await body(tool.slots[0]); expect(page.text.startsWith('real tool output 中文😀')).toBe(true); expect(page.complete).toBe(false);
    expect(await body(tool.slots[1])).toMatchObject({ text: 'raw tool result', complete: true });
    expect(await body(tool.slots[2])).toMatchObject({ text: '{"command":"true"}', complete: true });
  });

  it('keeps nested children and terminal output in their genuine source entity rather than making extra messages', async () => {
    const tool = await fields(await entity(commitRootArray(root, 'item')!, 2, 'tool'));
    const child = await fields(await entity(commitChildArray(tool)!, 0, 'child'));
    expect(child).toMatchObject({ turnId: 'c:turn:s1', id: 'c:turn:s1:tool:nested', kind: 'mcp-tool-call' });
    expect(child.slots.map(s => s.field)).toEqual(['rawOutput']); expect(await body(child.slots[0])).toMatchObject({ text: 'nested output' });
    const terminal = await fields(await entity(commitRootArray(root, 'terminal')!, 0, 'terminal'));
    expect(terminal).toMatchObject({ entity: 'terminal', id: 'actual-terminal', kind: 'terminal' });
    expect(terminal.slots.map(s => s.field)).toEqual(['output']); expect(await body(terminal.slots[0])).toMatchObject({ text: 'actual terminal output' });
  });

  it('rejects serialized/fake producer proofs, foreign sources and out-of-entity checkpoints before I/O', async () => {
    expect(() => commitRootArray(JSON.parse(JSON.stringify(root)) as CommitRootFacts, 'item')).toThrow('not issued');
    const parent = commitRootArray(root, 'item')!, array: CommitContainerIndex = { buildId: 'array', kind: 'array', range: { ...parent.range } };
    const budget = createWindowBudget();
    await expect(openCommitEntity(directory, { ...receipt, sourceId: 'other-source' }, parent, array, 0, 0, 'entity', budget)).rejects.toThrow('anchor');
    expect(budget.counters.indexBytes).toBe(0);
    const position = await entity(parent, 0, 'real'), cursor = createCommitEntityState(position);
    expect(() => createCommitEntityState({ ...position })).toThrow('Unknown');
    await expect(advance(position, { ...cursor, candidates: { text: { range: { start: 0, end: 2 }, string: true } } }, budget)).rejects.toThrow('body range');
    expect(budget.counters.indexBytes).toBe(0);
  });
});
