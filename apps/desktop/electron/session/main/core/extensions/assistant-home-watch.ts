import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { canonicalPath, type FileChangeSubscription } from '@gugu/session-core/files';
import { log } from '@main/lib/logger';
import { KeyedMutex } from '@gugu/session-core/lib';
import type { AssistantHomeHere } from './assistant-home-store';

/** Subscribe to the same single-directory change feed the workspace tree uses. Follow the resource
 * folders and the ancestry needed to notice a missing folder being created. No polling. */
export async function watchAssistantHome(home: AssistantHomeHere, signal: AbortSignal, changed: () => void): Promise<void> {
  const { runtimeManager } = await import('@main/core/runtime/runtime-manager');
  const lease = await runtimeManager.acquire();
  const root = canonicalPath(home.anchor);
  const inHome = (path: string) => join(root, relative(home.anchor, path));
  const roots = [home.paths.memoryDir, home.paths.resourcesDir, home.paths.skillsDir].map(inHome);
  const instructions = inHome(home.paths.instructions);
  const tracked = (path: string) => path === instructions || instructions.startsWith(path + sep)
    || roots.some(dir => path === dir || path.startsWith(dir + sep) || dir.startsWith(path + sep));
  const feeds = new Map<string, FileChangeSubscription>();
  const scans = new KeyedMutex();
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', stop);
    for (const feed of feeds.values()) feed.unsubscribe();
    feeds.clear();
    void lease.release();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) { stop(); return; }

  const refresh = () => scans.runExclusive(root, async () => {
    const seen = new Set<string>();
    async function visit(dir: string): Promise<void> {
      if (closed) return;
      seen.add(dir);
      if (!feeds.has(dir)) {
        const feed = lease.value.files.watchChanges(root, update => {
          if (closed) return;
          if (update.kind === 'changes' && !update.changes.some(entry => tracked(entry.path))) return;
          changed();
          if (update.kind === 'resync' || update.changes.some(entry => entry.kind !== 'update' && (entry.entryType !== 'file' || feeds.has(entry.path)))) {
            void refresh().catch(error => { stop(); log.warn('Assistant home watch ended', { error: String(error) }); });
          }
        }, { paths: [dir], recursive: false });
        if (!feed.success) throw Error(feed.error.message);
        feeds.set(dir, feed.data);
        const ready = await feed.data.ready();
        if (!closed && !ready.success) throw Error(ready.error.message);
      }
      if (closed) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        if (entry.name.startsWith('.') && !roots.some(path => path === child || path.startsWith(child + sep)) && !instructions.startsWith(child + sep)) continue;
        if (tracked(child)) await visit(child);
      }
    }
    await visit(root);
    for (const [dir, feed] of feeds) if (!seen.has(dir)) { feed.unsubscribe(); feeds.delete(dir); }
  });
  try { await refresh(); } catch (error) { stop(); throw error; }
}
