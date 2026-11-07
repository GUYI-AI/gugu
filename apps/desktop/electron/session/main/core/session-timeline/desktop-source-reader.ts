import { join } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createRecentReader } from '@gugu/session-core/session-record/window-cache/recent-reader';
import { createDiskBodyPageIo } from '@gugu/session-core/session-record/window-cache/body-reader';
import { readSourceLocator, readCapturedRecordStart } from '@gugu/session-core/session-record/window-cache/source-locator';
import { openWindowByteSource } from '@gugu/session-core/session-record/window-cache/file-source';
import { loadReverseIndexTask } from '@gugu/session-core/session-record/window-cache/record-locators';
import { createReverseIndexScheduler } from '@gugu/session-core/session-record/window-cache/reverse-index-runner';
import { createSourceReopenResolver } from '@gugu/session-core/session-record/window-cache/reopen-source';
import type { WindowReadRequest, WindowIoCounters, WindowSourceLocator } from '@gugu/session-core/session-record/window-cache/types';
import { createDesktopWindowReader } from './desktop-window-reader';

export type DesktopSourceRequest = WindowReadRequest & { cwd?: string; nativeSourcePath?: string };

/** One host-owned resolver; file discovery and page reads share the request budget. */
export function createDesktopSourceWindowReader(options: {
  request(id: string, limit?: number, signal?: AbortSignal): Promise<DesktopSourceRequest>;
  reportError(error: unknown): void;
  observed?(conversationId: string, io: Readonly<WindowIoCounters>, phase: 'window' | 'discovery'): void;
}) {
  type Discovery = { abort: AbortController; promise: Promise<WindowSourceLocator>; waiters: number };
  const discoveries = new Map<string, Discovery>();
  let available!: () => void;
  let capacity = new Promise<void>(resolve => { available = resolve; });
  const reported = new WeakSet<WindowReadRequest>();
  const listeners = new Set<() => void>();
  const locatedRequests = new WeakMap<WindowReadRequest, WindowSourceLocator>();
  const scheduler = createReverseIndexScheduler({ onFailure: options.reportError,
    onLocated: () => { for (const changed of listeners) changed(); } });
  async function locate(input: DesktopSourceRequest): Promise<WindowSourceLocator | null> {
    const cached = locatedRequests.get(input);
    if (cached) return cached;
    const harness = input.locator.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('Unsupported window source');
    const saved = await readSourceLocator(input.cacheDirectory, harness, input.locator.providerSessionId, input.budget);
    if (saved.kind === 'hit') { locatedRequests.set(input, saved.locator); return saved.locator; }
    if (saved.reason !== 'not_found') throw new Error(`Source locator failure: ${saved.reason}`);
    return null;
  }
  function finish(input: WindowReadRequest) {
    if (reported.has(input)) return;
    reported.add(input); options.observed?.(input.conversationId, input.budget.counters, 'window');
  }
  async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_yes, no) => {
        cancel = () => no(signal?.reason ?? new Error('Source discovery cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      })]);
    } finally { if (cancel) signal?.removeEventListener('abort', cancel); }
  }
  /** Two resolver slots; callers beyond capacity await cancellable backpressure.
   * Only admitted jobs own directory handles; different sessions never cancel each other. */
  async function locateForRead(input: DesktopSourceRequest): Promise<WindowSourceLocator> {
    const saved = await locate(input);
    input.signal?.throwIfAborted();
    if (saved) return saved;
    const key = JSON.stringify([input.cacheDirectory, input.locator, input.cwd, input.nativeSourcePath]);
    while (!discoveries.has(key) && discoveries.size >= 2) await cancellable(capacity, input.signal);
    let selected = discoveries.get(key);
    if (!selected) {
      const abort = new AbortController(), resolver = createSourceReopenResolver();
      const promise = (async () => {
        try {
          for (;;) {
            abort.signal.throwIfAborted();
            const budget = createWindowBudget();
            try {
              const result = await resolver.resolveSourceForReopen(input, budget, abort.signal);
              if (result.kind === 'located') return { version: 1 as const, harness: input.locator.harness as 'claude' | 'codex',
                providerSessionId: input.locator.providerSessionId, path: result.path, source: result.source, sourceLineage: result.sourceLineage };
              if (result.kind === 'cache_miss') throw Object.assign(new Error('Native record source was not found'), { code: 'record_not_found' });
            } finally { options.observed?.(input.conversationId, budget.counters, 'discovery'); }
            await setImmediate(undefined, { signal: abort.signal });
          }
        } finally {
          await resolver.dispose(); discoveries.delete(key);
          const wake = available; capacity = new Promise<void>(resolve => { available = resolve; }); wake();
        }
      })();
      selected = { abort, promise, waiters: 0 }; discoveries.set(key, selected);
    }
    selected.waiters += 1;
    try {
      const value = await cancellable(selected.promise, input.signal);
      locatedRequests.set(input, value); return value;
    } finally { selected.waiters -= 1; if (selected.waiters === 0) selected.abort.abort(); }
  }
  function reader(input: WindowReadRequest) {
    return createRecentReader({
      openSource: async current => {
        const located = await locateForRead(current);
        const source = await openWindowByteSource(located.path);
        try {
          if ((await source.snapshot()).sourceInstance !== located.source.sourceInstance)
            throw new Error('Native source locator refers to a replaced file');
          return { source, sourceLineage: located.sourceLineage, close: () => source.close() };
        } catch (error) { await source.close(); throw error; }
      },
      body: createDiskBodyPageIo(join(input.cacheDirectory, 'bodies'), async (_body, budget) => {
        const located = await locate({ ...input, budget });
        if (!located) return false;
        const source = await openWindowByteSource(located.path);
        try { const current = await source.snapshot(); return current.sourceInstance === _body.sourceLineage && current.snapshotRevision === _body.revision; }
        finally { await source.close(); }
      }),
      schedulePending: async (current, snapshot, ticket) => {
        const located = await locate(current);
        if (!located) throw new Error('Native source locator disappeared');
        const captured = await readCapturedRecordStart(current.cacheDirectory, located.harness,
          current.locator.providerSessionId, snapshot, current.budget);
        if (captured.kind === 'hit' && captured.range.end === ticket.sourceFence.end) return captured.range;
        const job = { scope: current.scope, sourceLineage: located.sourceLineage, decoderVersion: 1, jobId: ticket.ticket };
        const saved = await loadReverseIndexTask(current.cacheDirectory, job, current.budget);
        const checkpoint = saved.kind === 'hit' ? saved.position.checkpoint : { version: 1 as const, jobId: ticket.ticket,
          sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance, sourceLineage: located.sourceLineage,
          snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size, recordEnd: ticket.sourceFence.end,
          scanBefore: ticket.nextScanOffset, sourceFence: ticket.sourceFence };
        if (checkpoint.sourceInstance !== snapshot.sourceInstance || checkpoint.snapshotRevision !== snapshot.snapshotRevision)
          throw new Error('Reverse checkpoint no longer matches the source revision');
        if (saved.kind === 'hit' && saved.position.kind === 'located') return saved.position.range;
        scheduler.schedule(located.path, checkpoint, current.cacheDirectory, current.scope);
      },
    });
  }
  async function measured<T>(input: WindowReadRequest, read: () => Promise<T>) {
    await scheduler.pause();
    try { return await read(); }
    finally { finish(input); }
  }
  const bridge = createDesktopWindowReader({ request: options.request, finish,
    openRecent: input => measured(input, () => reader(input).openRecent(input)),
    readOlder: input => measured(input, () => reader(input).readOlder(input)),
    readBody: input => measured(input, () => reader(input).readBody(input)),
    watch: async (_id, changed, input) => {
      const located = await locateForRead(input);
      listeners.add(changed);
      watchFile(located.path, { persistent: false, interval: 250 }, changed);
      return () => { listeners.delete(changed); unwatchFile(located.path, changed); };
    },
  });
  return { ...bridge, async dispose() { for (const job of discoveries.values()) job.abort.abort(); await scheduler.dispose(); await Promise.allSettled([...discoveries.values()].map(job => job.promise)); } };
}
