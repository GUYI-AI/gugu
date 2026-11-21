import { makeAutoObservable } from 'mobx';
import type { ViewId, WrapParams } from '@renderer/app/view-registry';

const MAX_STACK_SIZE = 50;

export type HistoryEntry =
  /** `place`: where inside the view (view-registry `placeParams`); visits to different places are different steps. */
  | { kind: 'view'; viewId: ViewId; params: WrapParams<ViewId>; place?: string }
  | { kind: 'tab'; projectId: string; sessionId: string; tabId: string };

function entriesEqual(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'view' && b.kind === 'view') {
    if (a.viewId !== b.viewId || a.place !== b.place) return false;
    // The session view is parameterized by sessionId — different sessions are distinct entries.
    if (a.viewId === 'session') {
      const ap = a.params as { sessionId?: string };
      const bp = b.params as { sessionId?: string };
      return ap.sessionId === bp.sessionId;
    }
    return true;
  }
  if (a.kind === 'tab' && b.kind === 'tab') {
    return a.tabId === b.tabId && a.sessionId === b.sessionId;
  }
  return false;
}

/** Collapses adjacent identical entries that appear after a prune. */
function flatten(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.filter((e, i) => i === 0 || !entriesEqual(e, entries[i - 1]!));
}

/**
 * Tracks a chronological back/forward navigation stack spanning both
 * view-level and tab-level navigations.
 *
 * - `push()` is a no-op while `back()`/`forward()` are applying an entry,
 *   which prevents reactive observers (e.g. SessionViewStore's tab reaction)
 *   from recording the restoration as a new entry.
 * - `prune()` removes entries for deleted entities and is a hook point for
 *   future entity-cleanup; it is not called in the initial iteration.
 */
export class NavigationHistoryStore {
  /** Append-only log; not observable — only `index` drives reactivity. */
  entries: HistoryEntry[] = [];
  index = -1;

  /** Set to true while back/forward is being applied. Suppresses push(). */
  private navigating = false;

  constructor() {
    makeAutoObservable(this, {
      entries: false,
      canGoBack: true,
      canGoForward: true,
    });
  }

  get canGoBack(): boolean {
    return this.index > 0;
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  push(entry: HistoryEntry): void {
    if (this.navigating) return;

    // Skip if identical to current entry (e.g. rapid re-activation of same tab)
    const current = this.entries[this.index];
    if (current && entriesEqual(current, entry)) return;

    // Truncate forward stack
    this.entries.splice(this.index + 1);
    this.entries.push(entry);

    // Bound to max size: drop oldest entry when over limit
    if (this.entries.length > MAX_STACK_SIZE) {
      this.entries.shift();
    } else {
      this.index++;
    }
  }

  /**
   * Where you were before the first recorded navigation (a launch lands on a view without navigating to it). The stack
   * starts there, so the first step after a launch has somewhere to go back to, as the shell's own history does.
   */
  start(entry: HistoryEntry): void {
    if (this.index < 0) this.push(entry);
  }

  /** The step you are on moved within its view (a segment switched in place): it now records where you are. */
  replaceCurrent(entry: HistoryEntry): void {
    if (this.navigating) return;
    const current = this.entries[this.index];
    if (current?.kind !== 'view' || entry.kind !== 'view' || current.viewId !== entry.viewId) return;
    this.entries[this.index] = entry;
  }

  back(apply: (entry: HistoryEntry) => void): void {
    if (!this.canGoBack) return;
    this.index--;
    this.navigating = true;
    try {
      apply(this.entries[this.index]!);
    } finally {
      this.navigating = false;
    }
  }

  forward(apply: (entry: HistoryEntry) => void): void {
    if (!this.canGoForward) return;
    this.index++;
    this.navigating = true;
    try {
      apply(this.entries[this.index]!);
    } finally {
      this.navigating = false;
    }
  }

  /**
   * Removes all entries matching the predicate, then collapses adjacent
   * identical entries so no-op back steps are not created.
   * The cursor is clamped to the surviving entry nearest the removed position.
   *
   * Hook point for future entity-cleanup (deleted conversations, closed tabs, etc.).
   */
  prune(predicate: (entry: HistoryEntry) => boolean): void {
    const currentEntry = this.entries[this.index];
    this.entries = flatten(this.entries.filter((e) => !predicate(e)));
    const newIndex = currentEntry ? this.entries.indexOf(currentEntry) : -1;
    this.index = newIndex !== -1 ? newIndex : Math.max(0, this.entries.length - 1);
  }
}
