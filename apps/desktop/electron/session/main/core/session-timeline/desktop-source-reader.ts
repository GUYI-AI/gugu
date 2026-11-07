import { join } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createRecentReader } from '@gugu/session-core/session-record/window-cache/recent-reader';
import { createDiskBodyPageIo } from '@gugu/session-core/session-record/window-cache/body-reader';
import { readSourceLocator } from '@gugu/session-core/session-record/window-cache/source-locator';
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
  const resolver = createSourceReopenResolver();
  let discoveryIdle: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const locatedRequests = new WeakMap<WindowReadRequest, WindowSourceLocator>();
  const scheduler = createReverseIndexScheduler({ onFailure: options.reportError,
    onLocated: () => { for (const changed of listeners) changed(); } });
  async function locate(input: DesktopSourceRequest): Promise<WindowSourceLocator> {
    const cached = locatedRequests.get(input);
    if (cached) return cached;
    const harness = input.locator.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('Unsupported window source');
    const saved = await readSourceLocator(input.cacheDirectory, harness, input.locator.providerSessionId, input.budget);
    if (saved.kind === 'hit') { locatedRequests.set(input, saved.locator); return saved.locator; }
    if (saved.reason !== 'not_found') throw new Error(`Source locator failure: ${saved.reason}`);
    const result = await resolver.resolveSourceForReopen(input, input.budget, input.signal);
    if (result.kind !== 'located') throw Object.assign(new Error(result.kind === 'unlocated'
      ? 'Native source discovery is continuing' : 'Native record source was not found'),
    { code: result.kind === 'unlocated' ? 'source_locating' : 'record_not_found' });
    const value = { version: 1 as const, harness, providerSessionId: input.locator.providerSessionId,
      path: result.path, source: result.source, sourceLineage: result.sourceLineage };
    locatedRequests.set(input, value);
    return value;
  }
  /** Resumable discovery is a background job, with an independently metered budget
   * per metadata batch. Serialize whole jobs because the resolver owns one cursor. */
  async function locateForRead(input: DesktopSourceRequest): Promise<WindowSourceLocator> {
    const previous = discoveryIdle;
    let release!: () => void;
    discoveryIdle = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      let batch = input;
      for (;;) {
        input.signal?.throwIfAborted();
        try { const value = await locate(batch); locatedRequests.set(input, value); return value; }
        catch (error) { if ((error as { code?: string }).code !== 'source_locating') throw error; }
        finally { if (batch !== input) options.observed?.(input.conversationId, batch.budget.counters, 'discovery'); }
        await setImmediate(undefined, { signal: input.signal });
        batch = { ...input, budget: createWindowBudget() };
      }
    } finally { release(); }
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
        const source = await openWindowByteSource(located.path);
        try { const current = await source.snapshot(); return current.sourceInstance === _body.sourceLineage && current.snapshotRevision === _body.revision; }
        finally { await source.close(); }
      }),
      schedulePending: async (current, snapshot, ticket) => {
        const located = await locate(current);
        const job = { scope: current.scope, sourceLineage: located.sourceLineage, decoderVersion: 1, jobId: ticket.ticket };
        const saved = await loadReverseIndexTask(current.cacheDirectory, job, current.budget);
        if (saved.kind === 'hit' && saved.position.kind === 'located') return;
        const checkpoint = saved.kind === 'hit' ? saved.position.checkpoint : { version: 1 as const, jobId: ticket.ticket,
          sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance, sourceLineage: located.sourceLineage,
          snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size, recordEnd: ticket.sourceFence.end,
          scanBefore: ticket.nextScanOffset, sourceFence: ticket.sourceFence };
        if (checkpoint.sourceInstance !== snapshot.sourceInstance || checkpoint.snapshotRevision !== snapshot.snapshotRevision)
          throw new Error('Reverse checkpoint no longer matches the source revision');
        scheduler.schedule(located.path, checkpoint, current.cacheDirectory, current.scope);
      },
    });
  }
  async function measured<T>(input: WindowReadRequest, read: () => Promise<T>) {
    await scheduler.pause();
    try { return await read(); }
    finally { options.observed?.(input.conversationId, input.budget.counters, 'window'); }
  }
  const bridge = createDesktopWindowReader({ request: options.request,
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
  return { ...bridge, async dispose() { await scheduler.dispose(); await resolver.dispose(); } };
}
