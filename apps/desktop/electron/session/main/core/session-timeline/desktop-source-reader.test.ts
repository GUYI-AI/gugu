import { mkdtemp, mkdir, rm, writeFile, realpath, appendFile, stat, utimes, rename } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createDesktopSourceWindowReader } from './desktop-source-reader';
import type { DesktopSourceRequest } from './desktop-source-reader';
import type { WindowIoCounters } from '@gugu/session-core/session-record/window-cache/types';
import { supportsSourceWindow } from '@gugu/session-core/session-record/window-cache/formats';

const reads = vi.hoisted(() => ({ source: 0, index: 0, maximum: 0, onDirectoryRead: null as (() => void | Promise<void>) | null,
  ranges: [] as { path: string; start: number; end: number }[],
  watchers: new Map<string, Set<(current: Stats, previous: Stats) => void>>(),
  beforeSourceRead: null as ((path: string, position: number, close: () => Promise<void>) => void | Promise<void>) | null }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, watchFile: (...args: Parameters<typeof fs.watchFile>) => {
    const path = String(args[0]), listener = args.at(-1) as (current: Stats, previous: Stats) => void;
    const watchers = reads.watchers.get(path) ?? new Set(); watchers.add(listener); reads.watchers.set(path, watchers);
    return Reflect.apply(fs.watchFile, fs, args);
  }, unwatchFile: (...args: Parameters<typeof fs.unwatchFile>) => {
    const watchers = reads.watchers.get(String(args[0]));
    if (args[1]) watchers?.delete(args[1] as unknown as (current: Stats, previous: Stats) => void); else watchers?.clear();
    return fs.unwatchFile(...args);
  } };
});
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: () => { throw new Error('Whole-file reads are forbidden'); },
    readdir: () => { throw new Error('Whole-directory reads are forbidden'); },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await fs.opendir(...args), read = directory.read.bind(directory);
      vi.spyOn(directory, 'read').mockImplementation((async () => {
        const result = await read(); await reads.onDirectoryRead?.(); return result;
      }) as typeof directory.read);
      return directory;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args), read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation((async (...values: unknown[]) => {
        if (String(args[0]).endsWith('.jsonl')) await reads.beforeSourceRead?.(String(args[0]), Number(values[3]), () => file.close());
        const result = await Reflect.apply(read, file, values);
        const kind = String(args[0]).endsWith('.jsonl') ? 'source' : 'index';
        if (kind === 'source') reads.ranges.push({ path: String(args[0]), start: Number(values[3]), end: Number(values[3]) + result.bytesRead });
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
  await writeFile(join(directory, 'rollout-2026-11-07T00-00-00-other-id.jsonl'), row('other real body'));
  const roots = [sourceRoot];
  if (multipleBatches) {
    const unrelated = join(root, 'unrelated'); await mkdir(unrelated);
    for (let index = 0; index < 130; index += 1) await writeFile(join(unrelated, `ignored-${index}`), '');
    roots.unshift(unrelated);
  }
  const measured: WindowIoCounters[] = [], observed: { id: string; phase: string; io: WindowIoCounters }[] = [], requests: DesktopSourceRequest[] = [];
  const reader = createDesktopSourceWindowReader({
    request: async (conversationId, limit, signal) => {
      const request: DesktopSourceRequest = { conversationId, locator: { harness: 'codex', providerSessionId: conversationId === 'missing' ? 'missing' : conversationId === 'other' ? 'other-id' : 'native-id', roots },
        cacheDirectory: join(root, 'cache'), scope: 'a'.repeat(64), conversationScope: 'conversation', branchLineage: 'branch',
        budget: createWindowBudget(), limit, signal };
      requests.push(request); return request;
    }, reportError: error => { throw error; }, observed: (id, io, phase) => { observed.push({ id, phase, io: { ...io } }); if (phase === 'window') measured.push({ ...io }); },
    backgroundRead: (jobId, io) => observed.push({ id: jobId, phase: 'reverse', io: { ...io } }),
  });
  cleanup.push(() => reader.dispose());
  reads.source = 0; reads.index = 0; reads.maximum = 0; reads.ranges = []; reads.watchers.clear(); reads.onDirectoryRead = null; reads.beforeSourceRead = null;
  return { reader, measured, observed, requests, path: await realpath(path), row };
}

describe('desktop default source reopening', () => {
  it('pins two real opening EOFs independently, ignores append, and releases the cancelled pin', async () => {
    const { reader, path, row } = await fixture();
    await writeFile(path, row('first'));
    const texts = (events: ReturnType<typeof vi.fn>) => events.mock.calls.map(([event]) => {
      const value = event.result.ok ? event.result.batch : event.result.snapshot;
      return value.sourceFragments?.map((fragment: { text?: string }) => fragment.text);
    }).at(-1);
    const failed = vi.fn(), first = vi.fn(), second = vi.fn();
    const stopFirst = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'first', cursor: null }, first, failed);
    cleanup.push(async () => stopFirst());
    await vi.waitFor(() => expect(texts(first)).toEqual(['first']));
    const before = await stat(path);
    await appendFile(path, row('second'));
    const middle = await stat(path);
    for (const notify of reads.watchers.get(path) ?? []) notify(middle, before);
    const stopSecond = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'second', cursor: null }, second, failed);
    cleanup.push(async () => stopSecond());
    await vi.waitFor(() => expect(texts(second)).toEqual(['first', 'second']));
    await appendFile(path, row('third'));
    const appended = await stat(path);
    for (const notify of reads.watchers.get(path) ?? []) notify(appended, middle);
    // Force a structural refresh at the current physical revision. Each reader
    // must retain its own range cap, rather than use a fake snapshot size.
    await utimes(path, appended.atime, new Date(appended.mtimeMs + 1000));
    const touched = await stat(path);
    for (const notify of reads.watchers.get(path) ?? []) notify(touched, appended);
    await vi.waitFor(() => { expect(first.mock.calls.length).toBeGreaterThan(1); expect(second.mock.calls.length).toBeGreaterThan(1); });
    expect(texts(first)).toEqual(['first']); expect(texts(second)).toEqual(['first', 'second']);
    expect(reads.ranges.every(read => read.end <= middle.size)).toBe(true);
    stopFirst(); stopSecond();
    expect(reads.watchers.get(path)?.size).toBe(0);
    const reopened = vi.fn();
    const stopReopened = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'reopened', cursor: null }, reopened, failed);
    cleanup.push(async () => stopReopened());
    await vi.waitFor(() => expect(texts(reopened)).toEqual(['first', 'second', 'third']));
    expect(failed).not.toHaveBeenCalled();
  });
  it.each(['truncate', 'replace'])('fails a %s of the opening physical source without publishing a new EOF', async change => {
    const { reader, path, row } = await fixture();
    await writeFile(path, row('opening body with a sufficiently large range'));
    const events = vi.fn(), failed = vi.fn();
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: change, cursor: null }, events, failed);
    cleanup.push(async () => stop());
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
    const before = await stat(path);
    if (change === 'replace') { await writeFile(path + '.new', row('new body')); await rename(path + '.new', path); }
    else await writeFile(path, row('short'));
    const after = await stat(path);
    for (const notify of [...reads.watchers.get(path) ?? []]) notify(after, before);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(failed.mock.calls[0][0].error.code).toBe('source_changed');
    expect(events).toHaveBeenCalledOnce(); expect(reads.watchers.get(path)?.size).toBe(0);
  });
  it('reports a fatal reverse read to its own window once and leaves another window live', async () => {
    const { reader, path, row, observed } = await fixture();
    const otherEvents = vi.fn(), otherFailed = vi.fn();
    const stopOther = await reader.subscribe({ conversationId: 'other', subscriptionId: 'healthy', cursor: null }, otherEvents, otherFailed);
    cleanup.push(async () => stopOther());
    await vi.waitFor(() => expect(otherEvents).toHaveBeenCalledOnce());
    const raw = row('giant body'.repeat(30000)); await writeFile(path, raw);
    const tail = Buffer.byteLength(raw) - 65536;
    reads.beforeSourceRead = async (target, position, close) => {
      if (target === path && position < tail) { reads.beforeSourceRead = null; await close(); }
    };
    const failed = vi.fn();
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'failed-job-owner', cursor: null }, vi.fn(), failed);
    cleanup.push(async () => stop());
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation', subscriptionId: 'failed-job-owner', state: 'failed',
      error: expect.objectContaining({ code: 'EBADF' }) }));
    await writeFile(path.replace('native-id', 'other-id'), row('healthy update!'));
    await vi.waitFor(() => expect(otherEvents).toHaveBeenCalledTimes(2));
    expect(otherFailed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    expect(observed.reduce((sum, item) => sum + item.io.sourceBytes, 0)).toBe(reads.source);
    expect(observed.reduce((sum, item) => sum + item.io.indexBytes, 0)).toBe(reads.index);
  });
  it('does not turn a cancelled reverse read into a failed window', async () => {
    const { reader, path, row, observed } = await fixture(), abort = new AbortController();
    const raw = row('giant body'.repeat(30000)); await writeFile(path, raw);
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
    reads.beforeSourceRead = async (target, position, close) => {
      if (target === path && position < Buffer.byteLength(raw) - 65536) {
        reads.beforeSourceRead = null; entered(); await gate; await close();
      }
    };
    const failed = vi.fn();
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'cancelled-owner', cursor: null }, vi.fn(), failed, abort.signal);
    cleanup.push(async () => stop());
    try { await started; abort.abort(); } finally { release(); }
    await vi.waitFor(() => expect(observed.some(item => item.phase === 'reverse')).toBe(true));
    await reader.dispose(); expect(failed).not.toHaveBeenCalled();
  });
  it('resumes an owned locating job after an unrelated foreground read pauses it', async () => {
    const { reader, path, row, requests } = await fixture();
    const text = 'first actual body'.repeat(20000), raw = row(text); await writeFile(path, raw);
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
    reads.beforeSourceRead = async (target, position) => {
      if (target === path && position < Buffer.byteLength(raw) - 65536) {
        reads.beforeSourceRead = null; entered(); await gate;
      }
    };
    const events = vi.fn(), failed = vi.fn();
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'resume-owner', cursor: null }, events, failed);
    cleanup.push(async () => stop());
    await started;
    const foreground = reader.snapshot({ conversationId: 'other' });
    try { await vi.waitFor(() => expect(requests.some(request => request.conversationId === 'other')).toBe(true)); }
    finally { release(); }
    expect((await foreground).sourceFragments?.[0].text).toBe('other real body');
    await vi.waitFor(() => expect(events.mock.calls.some(([event]) => {
      const page = event.result.ok ? event.result.batch : event.result.snapshot;
      return page.sourceFragments?.some((fragment: { text?: string }) => fragment.text && text.startsWith(fragment.text));
    })).toBe(true));
    expect(failed).not.toHaveBeenCalled();
  });
  it('selects supported source formats before invoking any native reader', () => {
    expect(['claude', 'codex'].map(supportsSourceWindow)).toEqual([true, true]);
    expect(['opencode', 'hermes', 'copilot', 'qwen', 'pi', 'codebuddy', null].map(supportsSourceWindow)).toEqual(Array(7).fill(false));
  });
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
    const { reader, observed, requests } = await fixture(true);
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const event = new Promise((yes, no) => { resolve = yes; reject = no; });
    const stop = await reader.subscribe({ conversationId: 'conversation', subscriptionId: 'sub', cursor: null }, resolve, reject);
    cleanup.push(async () => stop());
    const received = await event as { result: { snapshot: { sourceFragments: { text: string }[] } } };
    expect(received.result.snapshot.sourceFragments.some(value => value.text === 'latest real body')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(observed.length).toBeGreaterThan(1);
    expect(observed.reduce((sum, value) => sum + value.io.sourceBytes, 0)).toBe(reads.source);
    expect(observed.reduce((sum, value) => sum + value.io.indexBytes, 0)).toBe(reads.index);
  });
  it('cancels discovery before installing a watch or reading source text', async () => {
    const { reader } = await fixture(true), abort = new AbortController();
    reads.onDirectoryRead = () => abort.abort();
    const emit = vi.fn(), failed = vi.fn();
    await expect(reader.subscribe({ conversationId: 'conversation', subscriptionId: 'sub', cursor: null }, emit, failed, abort.signal)).rejects.toThrow();
    expect(reads.source).toBe(0); expect(emit).not.toHaveBeenCalled();
  });
  it('lets a known source bypass discovery and cancels another waiter before that discovery finishes', async () => {
    const { reader, observed } = await fixture(true);
    await reader.snapshot({ conversationId: 'known', limit: 1 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const started = new Promise<void>(yes => { entered = yes; });
    reads.onDirectoryRead = async () => { entered(); await gate; };
    const long = reader.snapshot({ conversationId: 'missing' }).catch(error => error);
    await started;
    try {
      let shown = false;
      const known = reader.snapshot({ conversationId: 'known', limit: 1 }).then(value => { shown = true; return value; });
      await vi.waitFor(() => expect(shown).toBe(true));
      expect((await known).sourceFragments?.[0].text).toBe('latest real body');
      const abort = new AbortController();
      let cancelled = false;
      const waiter = reader.subscribe({ conversationId: 'missing', subscriptionId: 'cancel', cursor: null }, vi.fn(), vi.fn(), abort.signal)
        .catch(() => { cancelled = true; });
      abort.abort();
      await vi.waitFor(() => expect(cancelled).toBe(true)); await waiter;
      expect(observed.filter(value => value.id === 'missing' && value.phase === 'window')).toHaveLength(1);
    } finally { release(); await long; }
  });
  it('reports setup failure exactly once including the initial locator lookup', async () => {
    const { reader, observed, requests } = await fixture();
    await expect(reader.subscribe({ conversationId: 'missing', subscriptionId: 'not-found', cursor: null }, vi.fn(), vi.fn())).rejects.toThrow('not found');
    const terminal = observed.filter(value => value.id === 'missing' && value.phase === 'window');
    expect(terminal).toHaveLength(1); expect(terminal[0].io).toEqual(requests[0].budget.counters);
    expect(observed.reduce((sum, value) => sum + value.io.indexBytes, 0)).toBe(reads.index);
  });
  it('admits two valid unregistered subscriptions without cross-session cancellation', async () => {
    const { reader } = await fixture(true);
    const failed = vi.fn();
    const open = async (conversationId: string) => {
      let resolve!: (text: string) => void;
      const text = new Promise<string>(yes => { resolve = yes; });
      const stop = await reader.subscribe({ conversationId, subscriptionId: conversationId, cursor: null }, event => {
        const value = event.result.ok ? event.result.batch : event.result.snapshot;
        const body = value.sourceFragments?.find(value => value.text)?.text;
        if (body) resolve(body);
      }, failed);
      cleanup.push(async () => stop()); return text;
    };
    expect(await Promise.all([open('conversation'), open('other')])).toEqual(['latest real body', 'other real body']);
    expect(failed).not.toHaveBeenCalled();
  });

  it('does not pass an old cancellation to an immediate same-source reopen', async () => {
    const { reader } = await fixture(true);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const started = new Promise<void>(yes => { entered = yes; });
    reads.onDirectoryRead = async () => { entered(); await gate; };
    const first = new AbortController();
    const opening = reader.subscribe({ conversationId: 'conversation', subscriptionId: 'first', cursor: null }, vi.fn(), vi.fn(), first.signal)
      .then(() => false, () => true);
    await started; first.abort(); expect(await opening).toBe(true);
    let resolve!: () => void;
    const shown = new Promise<void>(yes => { resolve = yes; });
    const next = reader.subscribe({ conversationId: 'conversation', subscriptionId: 'second', cursor: null }, event => {
      const value = event.result.ok ? event.result.batch : event.result.snapshot;
      if (value.sourceFragments?.some(value => value.text === 'latest real body')) resolve();
    }, error => { throw error; });
    release(); const stop = await next; cleanup.push(async () => stop()); await shown;
  });
  it('replaces an unknown giant tail ticket with real first-body text after locating its start', async () => {
    const { reader, path, measured, observed } = await fixture();
    const text = '中文😀 real body '.repeat(8000);
    await writeFile(path, JSON.stringify({ metadata: 'x'.repeat(70000), type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }, { type: 'output_text', text }] } }) + '\n');
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
    expect(observed.some(value => value.phase === 'reverse' && value.io.sourceBytes > 0)).toBe(true);
    expect(observed.reduce((sum, value) => sum + value.io.sourceBytes, 0)).toBe(reads.source);
    expect(observed.reduce((sum, value) => sum + value.io.indexBytes, 0)).toBe(reads.index);
  });
});
