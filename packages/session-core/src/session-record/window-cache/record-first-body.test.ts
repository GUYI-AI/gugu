import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { createDiskBodyPageIo, readIndexedBodyPage } from './body-reader';
import { readRecordFirstBody } from './record-first-body';
import { locateRecordBody, recordHeaderKey } from './json-body-header';
import { readWindowFrame, writeWindowFrame } from './disk-frame';
import { windowFrameName } from './frame';
import type { WindowReadRequest } from './types';

describe('located record first body', () => {
  it.each(['version', 'state', 'checksum'] as const)('rebuilds a %s header checkpoint from its nonzero record anchor', async fault => {
    const directory = await mkdtemp(join(tmpdir(), 'header-rebuild-'));
    const text = 'actual body 中文😀'.repeat(10000), prefix = ' '.repeat(2999) + '\n';
    const raw = JSON.stringify({ metadata: 'x'.repeat(70000), uuid: 'native-record', message: {
      role: 'assistant', content: [{ type: 'text', text }] } });
    const path = join(directory, 'record.jsonl'); await writeFile(path, prefix + raw + '\n');
    const source = await openWindowByteSource(path), snapshot = await source.snapshot(), positions: number[] = [];
    const range = { start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + raw) };
    const request = (): WindowReadRequest => ({ conversationId: 'session', locator: { harness: 'claude', providerSessionId: 'native', roots: [directory] },
      cacheDirectory: join(directory, 'cache'), scope: 'a'.repeat(64), conversationScope: 'conversation', branchLineage: 'branch', budget: createWindowBudget() });
    const opened = { snapshot: () => source.snapshot(), read: (...args: Parameters<typeof source.read>) => {
      if (args[3] < range.start) throw new Error('Source prefix must not be read');
      positions.push(args[3]); return source.read(...args);
    } };
    try {
      await mkdir(request().cacheDirectory);
      expect(await locateRecordBody(opened, snapshot, range, request())).toMatchObject({ kind: 'locating' });
      const key = recordHeaderKey(snapshot, range, request()), headers = join(request().cacheDirectory, 'body-headers');
      const cached = await readWindowFrame(headers, key, createWindowBudget());
      if (cached.kind !== 'hit') throw new Error('Expected durable header checkpoint');
      if (fault === 'checksum') {
        const packet = await readFile(join(headers, windowFrameName(key))); packet[packet.length - 1] ^= 1;
        await writeFile(join(headers, windowFrameName(key)), packet);
      } else {
        const state = JSON.parse(new TextDecoder().decode(cached.bytes));
        if (fault === 'version') state.version = 2; else state.stack = null;
        await writeWindowFrame(headers, key, Buffer.from(JSON.stringify(state)));
      }
      positions.length = 0;
      const repair = request();
      expect(await readRecordFirstBody(opened, snapshot, range, snapshot.sourceInstance, repair)).toBeNull();
      expect(positions).toEqual([range.start]); expect(repair.budget.counters.sourceBytes).toBe(65536);
      positions.length = 0;
      const fragment = await readRecordFirstBody(opened, snapshot, range, snapshot.sourceInstance, request());
      if (!fragment || !('key' in fragment)) throw new Error('Expected real body after bounded repair');
      expect(text.startsWith(fragment.text!)).toBe(true); expect(fragment.text!.length).toBeGreaterThan(0);
      expect(positions.every(position => position >= range.start + 65536)).toBe(true);
    } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each([0, 70000])('resumes past %i metadata bytes and an empty first text block', async padding => {
    const directory = await mkdtemp(join(tmpdir(), 'header-progress-'));
    const text = 'actual body 中文😀'.repeat(10000);
    const raw = JSON.stringify({ metadata: 'x'.repeat(padding), uuid: 'native-record', message: {
      role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text }] } });
    const path = join(directory, 'record.jsonl'); await writeFile(path, raw + '\n');
    await mkdir(join(directory, 'cache'));
    let source = await openWindowByteSource(path);
    const snapshot = await source.snapshot(), positions: number[] = [];
    const request = (): WindowReadRequest => ({ conversationId: 'session', locator: { harness: 'claude', providerSessionId: 'native', roots: [directory] },
      cacheDirectory: join(directory, 'cache'), scope: 'a'.repeat(64), conversationScope: 'conversation', branchLineage: 'branch', budget: createWindowBudget() });
    const opened = () => ({ snapshot: () => source.snapshot(), read: (...args: Parameters<typeof source.read>) => {
      positions.push(args[3]); return source.read(...args);
    } });
    try {
      let fragment = await readRecordFirstBody(opened(), snapshot, { start: 0, end: Buffer.byteLength(raw) }, snapshot.sourceInstance, request());
      if (padding) {
        expect(fragment).toBeNull(); expect(positions).toEqual([0]);
        await source.close(); source = await openWindowByteSource(path); positions.length = 0;
        fragment = await readRecordFirstBody(opened(), snapshot, { start: 0, end: Buffer.byteLength(raw) }, snapshot.sourceInstance, request());
        expect(positions.every(position => position >= 65536)).toBe(true);
      }
      if (!fragment || !('key' in fragment)) throw new Error('Expected actual body after the empty candidate');
      expect(text.startsWith(fragment.text!)).toBe(true); expect(fragment.text!.length).toBeGreaterThan(0);
    } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each(['claude', 'codex'] as const)('publishes %s text and real disk refs without decoding the whole record', async provider => {
    const directory = await mkdtemp(join(tmpdir(), 'first-body-'));
    const text = '中文😀 escaped " \\ \n'.repeat(10000);
    const raw = JSON.stringify(provider === 'claude'
      ? { uuid: 'native-record', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
      : { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
    const path = join(directory, 'record.jsonl'); await writeFile(path, raw + '\n');
    const source = await openWindowByteSource(path), snapshot = await source.snapshot();
    const request: WindowReadRequest = { conversationId: 'conversation', locator: { harness: provider, providerSessionId: 'native', roots: [directory] },
      cacheDirectory: join(directory, 'cache'), scope: 'a'.repeat(64), conversationScope: 'conversation', branchLineage: 'branch', budget: createWindowBudget() };
    await mkdir(request.cacheDirectory);
    try {
      const fragment = await readRecordFirstBody(source, snapshot, { start: 0, end: Buffer.byteLength(raw) }, snapshot.sourceInstance, request);
      if (!fragment || !('key' in fragment)) throw new Error('Expected first body');
      expect(fragment.text).toBeTruthy(); expect(text.startsWith(fragment!.text!)).toBe(true);
      expect(Buffer.byteLength(fragment!.text!)).toBeLessThanOrEqual(16384);
      expect(fragment).toMatchObject({ ownership: 'unresolved', knownRole: 'assistant' });
      expect(fragment!.bodyRef!.owner).toEqual({ kind: 'fragment', fragmentKey: fragment!.key });
      expect(request.budget.counters.sourceBytes).toBeLessThanOrEqual(131072);
      expect(request.budget.counters.decodedBytes).toBeLessThanOrEqual(98304);
      const budget = createWindowBudget();
      const io = createDiskBodyPageIo(join(request.cacheDirectory, 'bodies'), async body =>
        (await source.snapshot()).snapshotRevision === body.revision);
      const page = await readIndexedBodyPage(io, { bodyRef: fragment!.bodyRef!, offset: 0, maxBytes: Buffer.byteLength(fragment!.text!), budget });
      expect(page.kind).toBe('body');
      if (page.kind !== 'body') throw new Error('Expected durable first body page');
      expect(page.text).toBe(fragment!.text); expect(page.previousOffset).toBeNull();
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
      const repeat = await readRecordFirstBody(source, snapshot, { start: 0, end: Buffer.byteLength(raw) }, snapshot.sourceInstance, { ...request, budget: createWindowBudget() });
      if (!repeat || !('key' in repeat)) throw new Error('Expected repeated first body');
      expect(repeat.key).toBe(fragment!.key); expect(repeat?.bodyRef).toEqual(fragment!.bodyRef);
    } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
