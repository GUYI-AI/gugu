import { describe, expect, it, vi } from 'vitest';
import { HOST_EVENTS } from '@shared/extensions/host-calls';
import { createGugu } from './create-gugu';

/**
 * #1925 (46) `gugu.bindings.work` / `openWork` / `closeWork` / `onWorkChanged` as a page reaches them: called straight through
 * (the preload reads the gesture on `openWork`'s very call), refusals as coded Errors, and `onWorkChanged(name, fn)` built on
 * the raw `bindings.onWork` event — one binding's answers to its listener. A host without them has none.
 */
const files = { files: () => new Promise<never>(() => {}) };
const binding = (over: Record<string, unknown> = {}) => ({ get: vi.fn(async (name: string) => ({ name, state: 'unbound', actions: [] })), ...over });

describe('gugu.bindings work members', () => {
  it('work, openWork, closeWork and onWorkChanged; the raw event stays the host\'s', async () => {
    let hear: ((work: unknown) => void) | undefined;
    const work = vi.fn(async (name: string) => ({ name, state: 'unavailable', open: null }));
    const openWork = vi.fn((_name: string, _handle: string) => Promise.reject({ code: 'not-found', message: 'That task is not in the list now' }));
    const closeWork = vi.fn(async () => undefined);
    const onWork = (handler: (work: unknown) => void) => { hear = handler; return () => { hear = undefined; }; };
    const gugu = createGugu({ appFiles: {}, reportError: () => {}, bindings: binding({ work, openWork, closeWork, onWork }) } as never, files) as Record<string, unknown> & {
      bindings: Record<string, (...args: unknown[]) => unknown>;
    };
    expect(Object.keys(gugu.bindings).sort()).toEqual(['closeWork', 'get', 'onWorkChanged', 'openWork', 'work']);
    expect(await gugu.bindings.work('main')).toEqual({ name: 'main', state: 'unavailable', open: null });
    // Straight through, in the same turn: the preload judges the gesture on this very call.
    const opening = gugu.bindings.openWork('main', 'wAAAAAAAAAAAAAAAAAAAAAA') as Promise<unknown>;
    expect(openWork).toHaveBeenCalledExactlyOnceWith('main', 'wAAAAAAAAAAAAAAAAAAAAAA');
    await expect(opening).rejects.toMatchObject({ code: 'not-found', message: expect.any(String) });
    expect(await gugu.bindings.closeWork('main')).toBeUndefined();
    const heard = vi.fn();
    const off = gugu.bindings.onWorkChanged('main', heard) as () => void;
    const mine = { name: 'main', state: 'ready', items: [], stale: false, open: null };
    hear!({ name: 'other', state: 'unbound' });
    hear!(mine);
    expect(heard).toHaveBeenCalledExactlyOnceWith(mine);
    off();
    expect(hear).toBeUndefined();
    for (const args of [['main'], ['main', 'not a function'], [heard], [7, heard]]) {
      expect(() => gugu.bindings.onWorkChanged(...args)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
  });

  it('onWorkChanged gets what work answers, and nothing of the event itself', () => {
    const { pick } = HOST_EVENTS['bindings.onWork'];
    const work = { name: 'main', state: 'ready' as const, items: [], stale: true, open: null };
    expect(pick({ type: 'bindingWork', work })).toEqual([work]);
  });

  it('a host without them has none', () => {
    const gugu = createGugu({ appFiles: {}, reportError: () => {}, bindings: binding() } as never, files) as { bindings: Record<string, unknown> };
    expect(Object.keys(gugu.bindings)).toEqual(['get']);
  });
});
