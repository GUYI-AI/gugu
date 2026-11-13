import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { IWatchService, WatchEvent, WatchHandle } from '../services/fs-watch/api';
import type { FileChangeUpdate } from './changes/types';
import { FilesRuntime } from './files-runtime';
import { canonicalPath } from './paths';

/** The OS side: what was watched, and its events, said as the OS says them (real paths). */
class ManualWatchService implements IWatchService {
  private readonly consumers: Array<(events: WatchEvent[]) => void> = [];
  readonly roots: string[] = [];
  async nudge(): Promise<boolean> {
    return false;
  }
  watch(root: string, onEvents: (events: WatchEvent[]) => void): WatchHandle {
    this.roots.push(root);
    this.consumers.push(onEvents);
    return { ready: async () => {}, release: async () => {} };
  }
  emit(events: WatchEvent[]): void {
    for (const consumer of this.consumers) consumer(events);
  }
  async dispose(): Promise<void> {}
}

let base: string | undefined;
afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  base = undefined;
});

it('a folder named through a link (a server account link) is watched in its one spelling, and its changes said in it', async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'files-runtime-')));
  const real = path.join(base, 'account');
  const named = path.join(base, 'accounts-link');
  await mkdir(real);
  await symlink(real, named);
  await writeFile(path.join(real, 'notes.md'), 'one');
  const watcher = new ManualWatchService();
  const runtime = new FilesRuntime({ watcher });
  const updates: FileChangeUpdate[] = [];

  const root = canonicalPath(named);
  expect(root).toBe(real);
  const feed = runtime.watchChanges(root, (update) => updates.push(update));
  expect(feed.success).toBe(true);
  expect(watcher.roots).toEqual([real]);
  watcher.emit([{ kind: 'update', path: path.join(real, 'notes.md') }]);

  // No path is changed per event: the OS's spelling is the canonical one.
  expect(updates).toEqual([{ kind: 'changes', changes: [{ kind: 'update', path: path.join(real, 'notes.md'), entryType: 'file' }] }]);
});
