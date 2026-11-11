import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';
import type { AppResourceEvent } from '@shared/extensions/agent-resources';

/**
 * #1927 (42) `gugu.bindings`' agent resources on a page: the verbs reject with a coded Error, as every verb does, and
 * `onResourcesChanged(name, fn)` keeps one host watch per call — `changed` until `ended`, which the host says when the
 * grant went, or the runtime says when the host never started it.
 */
type Bindings = {
  get: unknown; resources: (name: string, domain: string) => Promise<unknown>; save: (name: string, change: object) => Promise<unknown>;
  onResourcesChanged: (name: unknown, fn: unknown) => () => void;
};
function page(watchAnswer: (args: unknown[]) => Promise<unknown>) {
  let deliver!: (watchId: string, event: AppResourceEvent) => void;
  const watch = vi.fn(async (...args: unknown[]) => watchAnswer(args));
  const reportError = vi.fn(async () => undefined);
  const gugu = createGugu({
    appFiles: {}, reportError,
    bindings: {
      get: vi.fn(), watch,
      resources: vi.fn(async () => Promise.reject({ code: 'denied', message: 'no chat:resources' })),
      resource: vi.fn(), save: vi.fn(async () => ({ state: 'conflict' })), remove: vi.fn(),
    },
    onBindingResources: (fn: typeof deliver) => { deliver = fn; return () => undefined; },
  } as never, {} as never) as unknown as { bindings: Bindings };
  return { bindings: gugu.bindings, watch, reportError, deliver: (watchId: string, event: AppResourceEvent) => deliver(watchId, event) };
}

describe('gugu.bindings agent resources on a page', () => {
  it('the verbs are there beside get, and a refusal is a coded Error', async () => {
    const { bindings } = page(async () => ({ state: 'watching' }));
    expect(Object.keys(bindings).sort()).toEqual(['get', 'onResourcesChanged', 'remove', 'resource', 'resources', 'save']);
    await expect(bindings.resources('main', 'memory')).rejects.toMatchObject({ code: 'denied', message: 'no chat:resources' });
    expect(await bindings.save('main', {})).toEqual({ state: 'conflict' });
  });

  it('each subscription hears its own watch until it ends or is stopped', async () => {
    const { bindings, watch, deliver } = page(async () => ({ name: 'main', state: 'watching' }));
    const first = vi.fn(), second = vi.fn();
    const stopFirst = bindings.onResourcesChanged('main', first);
    bindings.onResourcesChanged('main', second);
    expect(watch.mock.calls).toEqual([['1', 'main', true], ['2', 'main', true]]);
    deliver('1', { name: 'main', state: 'changed' });
    expect(first).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'changed' });
    expect(second).not.toHaveBeenCalled();
    deliver('2', { name: 'main', state: 'ended' });
    deliver('2', { name: 'main', state: 'changed' });
    expect(second.mock.calls).toEqual([[{ name: 'main', state: 'ended' }]]);
    stopFirst(); stopFirst();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(3));
    expect(watch.mock.calls.at(-1)).toEqual(['1', 'main', false]);
    deliver('1', { name: 'main', state: 'changed' });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('not started — no conversation chosen, or refused — ends at once; a refusal is reported as the App\'s error', async () => {
    const unbound = page(async () => ({ name: 'main', state: 'unbound' }));
    const heard = vi.fn();
    unbound.bindings.onResourcesChanged('main', heard);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'ended' }));
    const refused = page(async () => Promise.reject({ code: 'denied', message: 'A binding is the person\'s' }));
    const told = vi.fn();
    refused.bindings.onResourcesChanged('main', told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'ended' }));
    expect(refused.reportError).toHaveBeenCalledWith(expect.stringContaining('gugu.bindings.onResourcesChanged(main)'));
    expect(() => refused.bindings.onResourcesChanged('main', 'not a function')).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => refused.bindings.onResourcesChanged(7, told)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
