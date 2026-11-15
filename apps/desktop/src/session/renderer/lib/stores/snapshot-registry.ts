import { comparer, reaction } from 'mobx';
import { viewStateCache } from './view-state-cache';

export class SnapshotRegistry {
  private readonly disposers = new Map<string, () => void>();

  /**
   * Register an entity's snapshot with the registry: a MobX reaction writes `getSnapshot()` to the view state whenever
   * it structurally changes. The write is immediate — main holds it from then on and writes the disk behind it, so
   * nothing is lost to a quit right after a change.
   *
   * Call this AFTER restoring saved state so the initial value does not trigger
   * a spurious write (fireImmediately is false).
   *
   * @returns A disposer: stops the reaction. The entry stays — it is what the entity restores from next time.
   */
  register(key: string, getSnapshot: () => unknown): () => void {
    // Clean up any stale reaction for this key before creating a new one.
    this.disposers.get(key)?.();

    const disposer = reaction(
      () => getSnapshot(),
      (snapshot) => viewStateCache.write(key, snapshot),
      { equals: comparer.structural, fireImmediately: false }
    );

    this.disposers.set(key, disposer);

    return () => {
      disposer();
      this.disposers.delete(key);
    };
  }
}

export const snapshotRegistry = new SnapshotRegistry();
