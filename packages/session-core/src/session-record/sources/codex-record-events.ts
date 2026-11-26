import { watch as watchFile, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DirectoryWatch } from '../../services/fs-watch/impl/directory-watch';
import type { WatchEvent } from '../../services/fs-watch/api';
import type { SessionRecordLocator } from '../contract';

type Handle = { ready(): Promise<void>; dispose(): Promise<void> };
export type RecordDirectoryWatch = (path: string, changed: (events?: readonly WatchEvent[]) => void, failed: (error: unknown) => void) => Handle;
const watchDirectory: RecordDirectoryWatch = (path, changed, failed) =>
  new DirectoryWatch(path, changed, () => changed(), (_context, error) => failed(error), false);

/** Shallow discovery watches and one watch on the active rollout. */
export class CodexRecordEvents {
  private readonly handles = new Map<string, { ino: number; handle: Handle }>();
  private readonly targets = new Set<string>();
  private stopped = false;
  private dirty = false;
  private running: Promise<void> | null = null;
  private consume: ((locateAgain: boolean) => Promise<void>) | null = null;
  private file: string | null = null;
  private rollout: { path: string; dev: number; ino: number; watcher: FSWatcher } | null = null;
  private locateAgain = false;

  constructor(private readonly locator: SessionRecordLocator, private readonly failed: (error: unknown) => void,
    private readonly watch: RecordDirectoryWatch = watchDirectory) {
    // UUIDv7's date is a hint, not proof of persistence. Include adjacent UTC dates for local timezones and
    // today's date for resumed threads. Once located, the actual parent directory is watched as well.
    const stamp = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(locator.providerSessionId)
      ? Number.parseInt(locator.providerSessionId.replaceAll('-', '').slice(0, 12), 16) : Date.now();
    for (const root of locator.roots) {
      this.targets.add(resolve(root));
      this.targets.add(dirname(resolve(root)));
      for (const at of [stamp, Date.now()]) for (const delta of [-1, 0, 1]) {
        const date = new Date(at + delta * 86_400_000).toISOString().slice(0, 10).split('-');
        this.targets.add(join(root, ...date));
      }
    }
  }

  /** Establish native subscriptions before the caller checks the file. */
  async ready(): Promise<void> { await this.reconcile(); }

  async includeFile(file: string): Promise<void> {
    this.file = file;
    this.targets.add(dirname(file));
    await this.reconcile();
  }

  /** Changes during an initial read stay dirty and are drained once that read has installed its cursor. */
  activate(consume: (locateAgain: boolean) => Promise<void>): void {
    this.consume = consume;
    this.drain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const { handle } of this.handles.values()) void handle.dispose();
    this.handles.clear();
    this.closeRollout();
  }

  private changed = (events?: readonly WatchEvent[]): void => {
    const relevant = events?.filter(event => event.path.includes(this.locator.providerSessionId)
      || [...this.targets].some(target => target === event.path || target.startsWith(event.path + sep)));
    if (relevant && !relevant.length) return;
    this.enqueue(!relevant || relevant.some(event => event.kind !== 'update' || event.path !== this.file));
  };

  private enqueue(locateAgain: boolean): void {
    this.locateAgain ||= locateAgain;
    this.dirty = true;
    this.drain();
  }

  private drain(): void {
    if (this.stopped || !this.consume || this.running || !this.dirty) return;
    const run = (async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        const locateAgain = this.locateAgain;
        this.locateAgain = false;
        await this.reconcile();
        if (!this.stopped) await this.consume!(locateAgain);
      }
    })().catch(error => { if (!this.stopped) { this.stop(); this.failed(error); } })
      .finally(() => { if (this.running === run) this.running = null; this.drain(); });
    this.running = run;
  }

  private closeRollout(): void {
    const rollout = this.rollout;
    this.rollout = null;
    rollout?.watcher.close();
  }

  private async reconcileRollout(): Promise<void> {
    const path = this.file;
    if (this.stopped || path === null) return;
    try {
      const { dev, ino } = await stat(path);
      if (this.stopped || this.file !== path) return;
      const current = this.rollout;
      if (current?.path === path && current.dev === dev && current.ino === ino) return;

      // macOS directory notifications can defer changes until the writer closes its file.
      const watcher = watchFile(path, { persistent: false }, (event) => {
        if (this.rollout?.watcher === watcher) this.enqueue(event === 'rename');
      });
      this.closeRollout();
      this.rollout = { path, dev, ino, watcher };
      watcher.on('error', (error) => {
        if (this.rollout?.watcher !== watcher) return;
        this.stop();
        this.failed(error);
      });
      watcher.on('close', () => {
        if (this.rollout?.watcher !== watcher) return;
        this.rollout = null;
        this.enqueue(true);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (this.file === path) this.closeRollout(); // The directory watches still follow a replacement.
    }
  }

  private async reconcile(): Promise<void> {
    const wanted = new Set<string>();
    for (const target of this.targets) {
      let path = target;
      for (;;) {
        try {
          const info = await stat(path);
          if (!info.isDirectory()) throw new Error(`Codex record watch is not a directory: ${path}`);
          wanted.add(path);
          const old = this.handles.get(path);
          if (old?.ino === info.ino) break;
          if (this.stopped) return;
          const handle = this.watch(path, this.changed, error => {
            if (!this.stopped) { this.stop(); this.failed(error); }
          });
          try { await handle.ready(); } catch (error) { await handle.dispose(); throw error; }
          if (this.stopped) { await handle.dispose(); return; }
          this.handles.set(path, { ino: info.ino, handle });
          await old?.handle.dispose();
          break;
        } catch (error) {
          // A missing directory is followed from its nearest existing ancestor. A permission/watch failure is real.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
          path = dirname(path);
        }
      }
    }
    for (const [path, { handle }] of this.handles) if (!wanted.has(path)) {
      this.handles.delete(path);
      await handle.dispose();
    }
    await this.reconcileRollout();
  }
}
