import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createDesktopSourceWindowReader } from './desktop-source-reader';
import type { DesktopSourceRequest } from './desktop-source-reader';
import type { WindowIoCounters } from '@gugu/session-core/session-record/window-cache/types';

const reads = vi.hoisted(() => ({ source: 0, index: 0, maximum: 0, onDirectoryRead: null as (() => void) | null }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: () => { throw new Error('Whole-file reads are forbidden'); },
    readdir: () => { throw new Error('Whole-directory reads are forbidden'); },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await fs.opendir(...args), read = directory.read.bind(directory);
      vi.spyOn(directory, 'read').mockImplementation((async () => {
        const result = await read(); reads.onDirectoryRead?.(); return result;
      }) as typeof directory.read);
      return directory;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args), read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation((async (...values: unknown[]) => {
        const result = await Reflect.apply(read, file, values);
        const kind = String(args[0]).endsWith('.jsonl') ? 'source' : 'index';
        reads[kind] += result.bytesRead;
        reads.maximum = Math.max(reads.maximum, Number(values[2]));
        return result;
      }) as typeof file.read);
      return file;
    } };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function fixture(multipleBatches = false) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-reopen-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'sessions'), directory = join(sourceRoot, '2026', '11', '07');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout-2026-11-07T00-00-00-native-id.jsonl');
  const row = (text: string) => JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  await writeFile(path, row('old'.repeat(24000)) + row('latest real body'));
  const roots = [sourceRoot];
  if (multipleBatches) {
    const unrelated = join(root, 'unrelated'); await mkdir(unrelated);
    for (let index = 0; index < 130; index += 1) await writeFile(join(unrelated, `ignored-${index}`), '');
    roots.unshift(unrelated);
  }
  const measured: WindowIoCounters[] = [], requests: DesktopSourceRequest[] = [];
  const reader = createDesktopSourceWindowReader({
    request: async (conversationId, limit, signal) => {
      const request: DesktopSourceRequest = { conversationId, locator: { harness: 'codex', providerSessionId: 'native-id', roots },
        cacheDirectory: join(root, 'cache'), scope: 'a'.repeat(64), conversationScope: 'conversation', branchLineage: 'branch',
        budget: createWindowBudget(), limit, signal };
      requests.push(request); return request;
    }, reportError: error => { throw error; }, observed: (_id, io) => measured.push({ ...io }),
  });
  cleanup.push(() => reader.dispose());
  reads.source = 0; reads.index = 0; reads.maximum = 0; reads.onDirectoryRead = null;
  return { reader, measured, requests, path, row };
}

describe('desktop default source reopening', () => {
  it('discovers an unregistered source and reads real suffix text with one aggregate budget', async () => {
    const { reader, measured } = await fixture();
    const snapshot = await reader.snapshot({ conversationId: 'conversation', limit: 1 });
    expect(snapshot.sourceFragments?.map(value => value.text)).toEqual(['latest real body']);
    expect(snapshot.sourceFragments?.[0].ownership).toBe('unresolved');
    expect(snapshot.turns).toEqual([]);
    expect(snapshot.sourceLineage).toBeTruthy(); expect(snapshot.snapshotRevision).toBeTruthy();
    expect(measured[0].sourceBytes).toBe(reads.source);
    expect(measured[0].indexBytes).toBe(reads.index);
    expect(reads.source).toBe(65536); expect(reads.maximum).toBeLessThanOrEqual(65536);
    expect(measured[0].indexBytes).toBeLessThanOrEqual(65536);
    expect(measured[0].outputBytes).toBeLessThanOrEqual(128 * 1024);
  });
  it('uses the same request for subscription discovery and its first readable page', async () => {
    const { reader, measured, requests } = await fixture();
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const event = new Promise((yes, no) => { resolve = yes; reject = no; });
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'sub', cursor: null }, resolve, reject);
    cleanup.push(async () => stop());
    await event;
    expect(requests).toHaveLength(1);
    expect(measured[0]).toEqual(requests[0].budget.counters);
    expect(measured[0].sourceBytes).toBe(reads.source);
    expect(measured[0].indexBytes).toBe(reads.index);
  });
  it('replaces a rewritten source revision instead of appending stale fragment rows', async () => {
    const { reader, path, row } = await fixture();
    const before = await reader.snapshot({ conversationId: 'conversation', limit: 1 });
    await writeFile(path, row('replacement body'));
    const after = await reader.after({ conversationId: 'conversation', cursor: before.cursor });
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error('Expected a replacement snapshot');
    expect(after.reset).toBe('epoch_changed');
    expect(after.snapshot.sourceFragments?.map(value => value.text)).toEqual(['replacement body']);
  });
  it('continues metadata discovery until a single subscription produces real text', async () => {
    const { reader, measured, requests } = await fixture(true);
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const event = new Promise((yes, no) => { resolve = yes; reject = no; });
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'sub', cursor: null }, resolve, reject);
    cleanup.push(async () => stop());
    const received = await event as { result: { snapshot: { sourceFragments: { text: string }[] } } };
    expect(received.result.snapshot.sourceFragments.some(value => value.text === 'latest real body')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(measured.length).toBeGreaterThan(1);
    expect(measured.reduce((sum, io) => sum + io.sourceBytes, 0)).toBe(reads.source);
    expect(measured.reduce((sum, io) => sum + io.indexBytes, 0)).toBe(reads.index);
  });
  it('cancels discovery before installing a watch or reading source text', async () => {
    const { reader } = await fixture(true), abort = new AbortController();
    reads.onDirectoryRead = () => abort.abort();
    const emit = vi.fn(), failed = vi.fn();
    await expect(reader.subscribe({ conversationId: 'conversation', subscriptionId: 'sub', cursor: null }, emit, failed, abort.signal)).rejects.toThrow();
    expect(reads.source).toBe(0); expect(emit).not.toHaveBeenCalled();
  });
  it('replaces an unknown giant tail ticket with real first-body text after locating its start', async () => {
    const { reader, path, row, measured } = await fixture();
    const text = '中文😀 real body '.repeat(8000);
    await writeFile(path, row(text));
    let resolve!: (value: { text?: string }) => void, reject!: (error: unknown) => void;
    const shown = new Promise<{ text?: string }>((yes, no) => { resolve = yes; reject = no; });
    let loading = false;
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'giant', cursor: null }, event => {
      const value = event.result.ok ? event.result.batch : event.result.snapshot;
      if (value.pendingLongRecords?.length) loading = true;
      const fragment = value.sourceFragments?.find(value => value.text);
      if (fragment) resolve(fragment);
    }, reject);
    cleanup.push(async () => stop());
    const fragment = await shown;
    expect(loading).toBe(true); expect(text.startsWith(fragment.text!)).toBe(true);
    expect(Buffer.byteLength(fragment.text!)).toBeLessThanOrEqual(16384);
    expect(measured.every(io => io.sourceBytes <= 512 * 1024 && io.indexBytes <= 65536)).toBe(true);
  });
});
