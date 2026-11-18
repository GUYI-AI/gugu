import { observable, runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotRegistry } from './snapshot-registry';
import { viewStateCache } from './view-state-cache';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// Main writes the disk behind and flushes it on every way out, so the renderer hands over each change at once: a
// quit right after a change keeps it.
it('writes a changed snapshot at once, with no timer; nothing on register; the entry stays after dispose', () => {
  vi.useFakeTimers();
  const write = vi.spyOn(viewStateCache, 'write');
  const state = observable({ expandedProjectIds: ['project'], expandedSessionIds: ['parent'] });
  const dispose = new SnapshotRegistry().register('sidebar', () => ({
    expandedProjectIds: [...state.expandedProjectIds], expandedSessionIds: [...state.expandedSessionIds],
  }));
  expect(write).not.toHaveBeenCalled();
  runInAction(() => {
    state.expandedProjectIds.splice(0);
    state.expandedSessionIds.splice(0);
  });
  const saved = { expandedProjectIds: [], expandedSessionIds: [] };
  expect(write).toHaveBeenLastCalledWith('sidebar', saved);
  expect(viewStateCache.read('sidebar')).toEqual(saved);
  expect(vi.getTimerCount()).toBe(0);
  dispose();
  runInAction(() => { state.expandedProjectIds.push('again'); });
  expect(write, 'disposed: no more writes').toHaveBeenCalledTimes(1);
  expect(viewStateCache.read('sidebar'), 'what it restores from next time').toEqual(saved);
});
