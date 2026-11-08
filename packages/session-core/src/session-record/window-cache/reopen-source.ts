import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, realpath } from 'node:fs/promises';
import type { Dir, Dirent } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import type { SessionRecordLocator } from '../contract';
import { openWindowByteSource } from './file-source';
import { syncWindowDirectory } from './disk-frame';
import { writeSourceLocator } from './source-locator';
import type { WindowBudget } from './types';

type Request = { cacheDirectory: string; locator: SessionRecordLocator; cwd?: string; nativeSourcePath?: string };
type Frame = { directory: Dir; path: string; depth: number; pending: Dirent | null };

/** One selected discovery, <=4 open native YYYY/MM/DD directories, no collected listing.
 * A continuation is process-local; disposal invalidates it instead of claiming a durable directory cookie.
 * Successfully found source paths are persisted independently of disposable projection caches.
 */
export function createSourceReopenResolver() {
  let selected = '', cursor = '', rootIndex = 0, frames: Frame[] = [], disposed = false;
  let idle: Promise<void> = Promise.resolve();
  async function closeDirectories() {
    const closing = frames; frames = [];
    for (const frame of closing.reverse()) await frame.directory.close();
  }
  async function exhausted() {
    await closeDirectories(); selected = ''; rootIndex = 0;
    return { kind: 'cache_miss' as const, reason: 'not_found' as const };
  }
  async function point(request: Request, path: string, signal?: AbortSignal) {
    const harness = request.locator.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('Unsupported source discovery format');
    signal?.throwIfAborted();
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'cache_miss' as const, reason: 'not_found' as const }; throw error; }
    let authorized = false;
    for (const root of request.locator.roots) {
      let allowed: string;
      try { allowed = await realpath(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const within = relative(allowed, canonical);
      if (within && within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within)) { authorized = true; break; }
    }
    if (!authorized) throw new Error('Native source address is outside its declared roots');
    const name = basename(canonical), id = request.locator.providerSessionId;
    if (harness === 'claude' ? name !== `${id}.jsonl` : !name.startsWith('rollout-') || !name.endsWith(`-${id}.jsonl`))
      throw new Error('Native source address does not match its session id');
    const source = await openWindowByteSource(canonical);
    try {
      const snapshot = await source.snapshot();
      signal?.throwIfAborted();
      await mkdir(request.cacheDirectory, { recursive: true }); await syncWindowDirectory(dirname(request.cacheDirectory));
      await writeSourceLocator(request.cacheDirectory, { version: 1, harness, providerSessionId: id,
        path: canonical, source: snapshot, sourceLineage: snapshot.sourceInstance });
      signal?.throwIfAborted();
      if (disposed) throw new Error('Source discovery is disposed');
      return { kind: 'located' as const, path: canonical, source: snapshot, sourceLineage: snapshot.sourceInstance };
    } finally { await source.close(); }
  }
  return {
    async resolveSourceForReopen(request: Request, budget: WindowBudget, signal?: AbortSignal) {
      if (disposed) throw new Error('Source discovery is disposed');
      const { locator } = request;
      if (!locator.providerSessionId || /[/\\]/.test(locator.providerSessionId)) throw new Error('Invalid native session id');
      const previous = idle;
      let release!: () => void;
      idle = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (disposed) throw new Error('Source discovery is disposed');
        signal?.throwIfAborted();
        const key = createHash('sha256').update(JSON.stringify([request.cacheDirectory, locator.harness, locator.providerSessionId, locator.roots, request.cwd, request.nativeSourcePath])).digest('hex');
        if (key !== selected) { await closeDirectories(); selected = key; cursor = randomUUID(); rootIndex = 0; }
        // An explicit metadata address selects point lookup, even if it is stale/missing.
        if (request.nativeSourcePath !== undefined) return await point(request, request.nativeSourcePath, signal);
        const started = process.cpuUsage();
        let examined = 0;
        while (examined < 64 && (examined === 0 || process.cpuUsage(started).user + process.cpuUsage(started).system < 5_000)) {
          signal?.throwIfAborted();
          if (disposed) throw new Error('Source discovery is disposed');
          if (locator.harness === 'claude') {
            if (!request.cwd || rootIndex >= locator.roots.length) return await exhausted();
            const at = join(locator.roots[rootIndex], request.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${locator.providerSessionId}.jsonl`);
            const result = await point(request, at, signal); examined += 1; rootIndex += 1;
            if (result.kind === 'located') { selected = ''; return result; }
            continue;
          }
          if (locator.harness !== 'codex') return await exhausted();
          if (!frames.length) {
            if (rootIndex >= locator.roots.length) return await exhausted();
            const path = locator.roots[rootIndex];
            try { frames.push({ directory: await opendir(path, { bufferSize: 1 }), path, depth: 0, pending: null }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            rootIndex += 1; examined += 1;
            continue;
          }
          const frame = frames[frames.length - 1];
          if (!frame.pending) frame.pending = await frame.directory.read();
          signal?.throwIfAborted(); // Keep a consumed entry pending across cancellation.
          const entry = frame.pending;
          examined += 1;
          if (!entry) { await frame.directory.close(); frames.pop(); continue; }
          budget.charge('decodedBytes', Buffer.byteLength(entry.name));
          const path = join(frame.path, entry.name);
          if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${locator.providerSessionId}.jsonl`)) {
            const result = await point(request, path, signal);
            frame.pending = null;
            await closeDirectories();
            selected = '';
            return result;
          }
          // Native Codex uses sessions/YYYY/MM/DD; names are traversed, never time-ranked.
          if (entry.isDirectory() && frame.depth < 3 && (frame.depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
            frames.push({ directory: await opendir(path, { bufferSize: 1 }), path, depth: frame.depth + 1, pending: null });
          }
          frame.pending = null;
        }
        return { kind: 'unlocated' as const, cursor, examinedEntries: examined };
      } finally { release(); }
    },
    async dispose() { disposed = true; await idle; await closeDirectories(); },
  };
}
