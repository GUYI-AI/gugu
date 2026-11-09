import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowLivePosition } from '@gugu/session-wire/session-window-live';
import { createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { createWindowCommitPublisher } from './window-commit-publisher';
import { createWindowProjectionAdapter } from './window-projection-adapter';
import * as source from './window-commit-source';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('bounded canonical projection host adapter', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string, receipt: WindowCommitReceipt, position: WindowLivePosition;
  const body = 'first 中文😀 " \\ \n'.repeat(2000), detail = 'actual failure\n'.repeat(2000);
  const turn = (): TranscriptTurn => ({ id: 't', referenceId: 'reference', seq: 0, initiator: 'agent', startedAt: 123,
    outcome: { kind: 'error', reason: 'process_closed', detail },
    items: [{ kind: 'mcp-tool-call', id: 'tool', seq: 4, toolCallId: 'provider-call', title: 'Read', status: 'done', tool: 'read',
      parentToolCallId: 'provider-parent', locations: [{ path: '/real/path' }],
      contentBlocks: [{ type: 'fixture', array: [], object: {} }], rawInput: '{"real":true}', rawOutput: 'raw result' },
    { kind: 'message', id: 'answer', seq: 9, role: 'assistant', text: body }] });
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'projection-adapter-'));
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn(), windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'reference')!;
    const published = await createWindowCommitPublisher(directory, createWindowCommitReceipts(fixture.sqlite)).publish(receipt);
    position = { referenceId: receipt.referenceId, rowId: receipt.rowId, storedSeq: receipt.storedSeq, projectionId: published.projectionId };
  }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); });
  function gateway(options: { acquire?(): Promise<void>; cleanup?(): Promise<void> } = {}) {
    const owner = {}, authority = new Set([owner]), pins = new Set<object>(), released = vi.fn();
    let releaseError = false;
    const receipts = createWindowCommitReceipts(fixture.sqlite);
    const adapter = createWindowProjectionAdapter({ directory, receipts,
      authorize(actor, input) {
        if (!authority.has(actor)) throw new Error('owner');
        const found = receipts.bySource(input.projectionId.split('/')[0]);
        if (!found || found.sessionId !== 'c') throw new Error('authority'); return found;
      },
      assertOwner(actor) { if (!authority.has(actor)) throw new Error('owner'); },
      async acquire(pinOwner) { pins.add(pinOwner); await options.acquire?.(); return async () => {
        released(); if (releaseError) throw new Error('pin fsync failed'); pins.delete(pinOwner);
      }; },
      async releaseOwner(pinOwner) { await options.cleanup?.(); pins.delete(pinOwner); return { complete: true }; },
    });
    return { adapter, owner, authority, pins, released, failRelease(value: boolean) { releaseError = value; } };
  }
  const budget = () => createWindowBudget();
  it('keeps authentic rendering headers and opaque large details without source coordinates', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget());
    expect(opened.root.values).toMatchObject({ id: `c:turn:s${receipt.storedSeq}`, seq: receipt.storedSeq, initiator: 'agent', startedAt: 123,
      'outcome.kind': 'error', 'outcome.reason': 'process_closed' });
    expect(opened.root.values).not.toHaveProperty('endedAt');
    const field = opened.root.fields.find(v => v.field === 'outcome.detail')!;
    const first = await g.adapter.readField(g.owner, field.handle, budget());
    expect(first.kind).toBe('body'); if (first.kind !== 'body') throw new Error('expected actual detail');
    expect(detail.startsWith(first.text)).toBe(true); expect(first.next).not.toBeNull();
    const row = await g.adapter.readPage(g.owner, opened.next!, budget());
    expect(row.header.values).toMatchObject({ id: 'tool', seq: 4, kind: 'mcp-tool-call', toolCallId: 'provider-call', status: 'done',
      tool: 'read', parentToolCallId: 'provider-parent' });
    expect(row.parentEntityId).toBeNull();
    expect(JSON.stringify({ opened, row })).not.toMatch(/rawOffset|sourceLineage|"range"|"start"|"end"/);
    expect(g.pins.size).toBe(1);
  });
  it('reads the same real body through bounded Unicode pages and authentic sibling order', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget());
    const tool = await g.adapter.readPage(g.owner, opened.next!, budget()), row = await g.adapter.readPage(g.owner, tool.next!, budget());
    expect(row.header.values).toMatchObject({ id: 'answer', seq: 9, role: 'assistant' }); expect(row.next).toBeNull();
    let next: string | null = row.bodies.find(v => v.field === 'text')!.handle, text = '';
    while (next) {
      const io = budget(), page = await g.adapter.readField(g.owner, next, io);
      if (page.kind !== 'body') throw new Error('not a body');
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(16384); expect(page.offset).toBe(Buffer.byteLength(text));
      expect(io.counters.indexBytes).toBeLessThanOrEqual(65536); text += page.text; next = page.next;
    }
    expect(text).toBe(body);
    const replay = await g.adapter.readPage(g.owner, opened.next!, budget());
    expect(replay).toMatchObject({ ordinal: tool.ordinal, entityId: tool.entityId, header: { values: tool.header.values } });
  });
  it('enumerates structured metadata by references and never turns provider parents into publisher parents', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget()), row = await g.adapter.readPage(g.owner, opened.next!, budget());
    const locations = row.header.fields.find(v => v.field === 'locations')!;
    const array = await g.adapter.readField(g.owner, locations.handle, budget());
    if (array.kind !== 'values' || array.entries[0]?.value.kind !== 'field') throw new Error('not a structured reference');
    const object = await g.adapter.readField(g.owner, array.entries[0].value.handle, budget());
    if (object.kind !== 'values' || object.entries[0]?.value.kind !== 'field') throw new Error('not a location');
    const key = await g.adapter.readField(g.owner, object.entries[0].key!, budget());
    const value = await g.adapter.readField(g.owner, object.entries[0].value.handle, budget());
    expect(key).toMatchObject({ kind: 'body', text: 'path' }); expect(value).toMatchObject({ kind: 'body', text: '/real/path' });
  });
  it('preserves empty array and object kinds through nested opaque metadata handles', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget()), row = await g.adapter.readPage(g.owner, opened.next!, budget());
    const blocks = row.header.fields.find(v => v.field === 'contentBlocks')!;
    const array = await g.adapter.readField(g.owner, blocks.handle, budget());
    expect(array).toMatchObject({ kind: 'values', containerKind: 'array' });
    if (array.kind !== 'values' || array.entries[0]?.value.kind !== 'field') throw new Error('missing content block');
    expect(array.entries[0].value).toHaveProperty('fieldKind', 'object');
    const object = await g.adapter.readField(g.owner, array.entries[0].value.handle, budget());
    expect(object).toMatchObject({ kind: 'values', containerKind: 'object' });
    if (object.kind !== 'values') throw new Error('missing content members');
    const kinds: Record<string, unknown> = {};
    for (const entry of object.entries) {
      const key = await g.adapter.readField(g.owner, entry.key!, budget());
      if (key.kind !== 'body' || entry.value.kind !== 'field' || !['array', 'object'].includes(key.text)) continue;
      const empty = await g.adapter.readField(g.owner, entry.value.handle, budget());
      expect(empty).toMatchObject({ kind: 'values', containerKind: key.text, entries: [], next: null });
      kinds[key.text] = entry.value;
    }
    expect(kinds).toMatchObject({ array: { fieldKind: 'array' }, object: { fieldKind: 'object' } });
  });
  it('refuses another owner, forged handles and handles after release; release failures never restore read authority', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget());
    await expect(g.adapter.readPage({}, opened.next!, budget())).rejects.toThrow('owner');
    await expect(g.adapter.readPage(g.owner, `${opened.next!.slice(0, -5)}AAAAA`, budget())).rejects.toThrow();
    g.failRelease(true); await expect(g.adapter.release(g.owner, opened.lease, budget())).rejects.toThrow('pin fsync');
    await expect(g.adapter.readPage(g.owner, opened.next!, budget())).rejects.toMatchObject({ code: 'closed' });
    g.failRelease(false); await g.adapter.release(g.owner, opened.lease, budget());
    await g.adapter.release(g.owner, opened.lease, budget()); expect(g.pins.size).toBe(0); expect(g.released).toHaveBeenCalledTimes(2);
  });
  it('keeps a delivered immutable version through a later real canonical revision', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget());
    await persistCommittedTurn({ sessionId: 'c', source: 'revision', turn: { ...turn(), items: [] }, windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 4 }, committed: async () => {} } });
    const receipts = createWindowCommitReceipts(fixture.sqlite), newer = receipts.byReference('c', 'reference')!;
    await createWindowCommitPublisher(directory, receipts).publish(newer);
    const row = await g.adapter.readPage(g.owner, opened.next!, budget()); expect(row.header.values.id).toBe('tool');
    const failed = { ...position, rowId: 'another-row' };
    await expect(g.adapter.open(g.owner, failed, budget())).rejects.toMatchObject({ code: 'needs_location' });
  });
  it('rechecks the canonical receipt in the outer export after the final asynchronous proof', async () => {
    const g = gateway(), opened = await g.adapter.open(g.owner, position, budget()), row = await g.adapter.readPage(g.owner, opened.next!, budget());
    const validate = source.assertWindowCommitSource;
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => {
      await validate(...args); queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(receipt.rowId));
    });
    await expect(g.adapter.readField(g.owner, row.bodies[0].handle, budget())).rejects.toMatchObject({ code: 'needs_location' });
  });
  it('closes an in-flight acquire without releasing capacity or its pin until the actual operation settles', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const g = gateway({ async acquire() { entered.resolve(); await gate.promise; } });
    const pending = g.adapter.open(g.owner, position, budget());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); await entered.promise;
    expect(await g.adapter.close(g.owner, budget())).toEqual({ complete: false }); expect(g.pins.size).toBe(1);
    gate.resolve(); await rejected;
    expect(g.pins.size).toBe(0); expect(await g.adapter.close(g.owner, budget())).toEqual({ complete: true });
  });
  it('retains failed acquire cleanup for the root owner instead of dropping an unreturned durable pin', async () => {
    let retry = false;
    const g = gateway({ async acquire() { throw new Error('acquire final check failed'); },
      async cleanup() { if (!retry) throw new Error('cleanup fsync failed'); } });
    await expect(g.adapter.open(g.owner, position, budget())).rejects.toThrow('acquire final check');
    expect(g.pins.size).toBe(1); retry = true;
    expect(await g.adapter.close(g.owner, budget())).toEqual({ complete: true }); expect(g.pins.size).toBe(0);
  });
});
