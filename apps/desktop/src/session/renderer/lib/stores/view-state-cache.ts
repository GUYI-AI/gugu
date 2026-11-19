import { rpc } from '@renderer/lib/ipc';
import { createSelectStore } from '@/lib/selectStore';
import { log } from '@renderer/utils/logger';
import { FIRST_FRAME_GLOBAL, type FirstFrameGlobal } from '../../../../../shared/first-frame';
import { viewStateModelOf } from './view-state-models';

/**
 * Where the view state (③ in the client state model: drafts, reading positions, tabs, what is folded) is kept. Both
 * hand over every entry synchronously, oldest write first, before the first frame:
 * - desktop: main's database, read by preload over one synchronous IPC (shared/first-frame.ts); writes go to main,
 *   which writes them behind and flushes them on every way out;
 * - the web page and the phone have no main process: localStorage, one key per entry, stamped for the order.
 */
interface ViewStateStorage {
  entries: Record<string, unknown>;
  save(key: string, value: unknown): void;
  del(key: string): void;
}

const notStored = (key: string) => (error: unknown) => log.error('view state not stored', { key, error: String(error) });

function mainProcessStorage(global: FirstFrameGlobal): ViewStateStorage {
  if (!global.viewState) log.error('main handed over no view state: this start begins without drafts, positions or tabs');
  // The IPC is sent before this returns; main holds it from then on, so a quit right after keeps it.
  const send = (key: string, write: () => Promise<void>) => {
    try {
      write().catch(notStored(key));
    } catch (error) {
      notStored(key)(error);
    }
  };
  return {
    entries: global.viewState ?? {},
    save: (key, value) => send(key, () => rpc.viewState.save(key, value)),
    del: (key) => send(key, () => rpc.viewState.del(key)),
  };
}

const LOCAL_PREFIX = 'gugu.view-state:';
function localStorageStorage(): ViewStateStorage {
  const stored: Array<[string, number, unknown]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (!name?.startsWith(LOCAL_PREFIX)) continue;
    try {
      const { at, value } = JSON.parse(localStorage.getItem(name) ?? '') as { at: number; value: unknown };
      stored.push([name.slice(LOCAL_PREFIX.length), at, value]);
    } catch {
      log.error('stored view state is malformed; not restored', { key: name });
    }
  }
  let clock = 0;
  return {
    entries: Object.fromEntries(stored.sort((a, b) => a[1] - b[1]).map(([key, , value]) => [key, value])),
    save: (key, value) => {
      try {
        localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify({ at: (clock = Math.max(clock + 1, Date.now())), value }));
      } catch (error) {
        notStored(key)(error);
      }
    },
    del: (key) => localStorage.removeItem(LOCAL_PREFIX + key),
  };
}

/**
 * The renderer's view state, all of it in memory from the first frame. `read` is a Map lookup; `write` changes the
 * entry, tells its readers (`changes`, for useSelect) and hands it to the storage. The Map keeps write order, which is
 * the order a model over its cap evicts in (view-state-models.ts). An entry marked `persist: false` lives in memory only
 * (a settings dialog's unsaved edit: losing it on restart is by design).
 */
class ViewStateCache {
  private readonly map: Map<string, unknown>;
  private readonly memory = new Map<string, unknown>();
  /** Serialized size of each stored entry, in write order (an entry over its model's cap is in `map` but not here). */
  private readonly sizes = new Map<string, number>();
  private readonly overCap = new Set<string>();
  /** Bumped on every change; readers select their entry through it (useSelect). */
  readonly changes = createSelectStore(0);

  constructor(private readonly storage: ViewStateStorage) {
    this.map = new Map();
    // Entries stored before their caps existed (or by a model since removed) are held to the caps now.
    for (const [key, value] of Object.entries(storage.entries)) {
      if (viewStateModelOf(key)) this.put(key, value, false);
      else storage.del(key);
    }
  }

  read(key: string, persist = true): unknown {
    return persist ? this.map.get(key) : this.memory.get(key);
  }

  /** Every persisted key starting with `prefix`, oldest write first. */
  keys(prefix: string): string[] {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix));
  }

  /** Write an entry (undefined = drop it) and tell its readers. */
  write(key: string, value: unknown, persist = true): void {
    if (!persist) {
      if (value === undefined) this.memory.delete(key);
      else this.memory.set(key, value);
      this.changed();
      return;
    }
    const had = this.map.delete(key);
    if (value === undefined) {
      if (!had) return;
      this.sizes.delete(key);
      this.overCap.delete(key);
      this.storage.del(key);
      this.changed();
      return;
    }
    this.put(key, value, true);
    this.changed();
  }

  private put(key: string, value: unknown, save: boolean): void {
    const model = viewStateModelOf(key);
    if (!model) throw new Error(`view state "${key}" belongs to no model: declare its caps in view-state-models.ts`);
    this.map.set(key, value);
    const bytes = key.length + JSON.stringify(value).length;
    if (bytes > model.maxBytes) {
      // The last stored copy stays (an older draft beats none after a restart); said once per entry, not per keystroke.
      if (!this.overCap.has(key)) log.error('view state entry over its cap; kept in memory, the last stored copy stays', { model: model.name, key, bytes, maxBytes: model.maxBytes });
      this.overCap.add(key);
      return;
    }
    this.overCap.delete(key);
    this.sizes.delete(key);
    this.sizes.set(key, bytes);
    if (save) this.storage.save(key, value);
    // Oldest first, never the entry just written, until the model fits both caps.
    const own = [...this.sizes].filter(([other]) => model.match.test(other));
    let count = own.length, total = own.reduce((sum, [, size]) => sum + size, 0);
    for (const [evicted, size] of own) {
      if (evicted === key || (count <= model.maxEntries && total <= model.maxBytes)) break;
      this.map.delete(evicted);
      this.sizes.delete(evicted);
      this.storage.del(evicted);
      count -= 1;
      total -= size;
    }
  }

  /** Drop every persisted entry whose key starts with `prefix` (a conversation left or deleted). */
  forget(prefix: string): void {
    for (const key of this.keys(prefix)) {
      this.map.delete(key);
      this.sizes.delete(key);
      this.storage.del(key);
    }
    this.changed();
  }

  /** The in-memory entries whose key starts with `prefix` leave (an account signing out takes its unsaved edits). */
  forgetMemory(prefix: string): void {
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key);
    this.changed();
  }

  private changed(): void {
    this.changes.publish(this.changes.get() + 1);
    this.changes.notify();
  }
}

// No window (a node test importing this): nothing to keep across runs.
const inNode: ViewStateStorage = { entries: {}, save: () => {}, del: () => {} };
const global = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, FirstFrameGlobal | undefined>)[FIRST_FRAME_GLOBAL];
export const viewStateCache = new ViewStateCache(
  global ? mainProcessStorage(global) : typeof localStorage === 'undefined' ? inNode : localStorageStorage(),
);
