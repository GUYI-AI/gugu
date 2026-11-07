import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { createDiskBodyPageIo, readIndexedBodyPage } from './body-reader';
import { readRecordFirstBody } from './record-first-body';
import type { WindowReadRequest } from './types';

describe('located record first body', () => {
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
      expect(fragment?.text).toBeTruthy(); expect(text.startsWith(fragment!.text!)).toBe(true);
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
      expect(repeat?.key).toBe(fragment!.key); expect(repeat?.bodyRef).toEqual(fragment!.bodyRef);
    } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
