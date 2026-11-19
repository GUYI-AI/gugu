// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_STATE_BUDGET_BYTES, VIEW_STATE_MODELS, viewStateModelOf } from './view-state-models';

const ipc = vi.hoisted(() => ({ save: vi.fn(async (_key: string, _value: unknown) => {}), del: vi.fn(async (_key: string) => {}) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { save: ipc.save, del: ipc.del } } }));
const errors = vi.hoisted(() => vi.fn());
vi.mock('@renderer/utils/logger', () => ({ log: { error: errors, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

/** A fresh cache, as at a start: what main handed preload (desktop) or what localStorage holds (web, phone). */
async function start(snapshot?: Record<string, unknown> | null) {
  vi.resetModules();
  const win = window as unknown as Record<string, unknown>;
  if (snapshot === undefined) delete win.guguFirstFrame;
  else win.guguFirstFrame = { viewState: snapshot, devicePreferences: null };
  return (await import('./view-state-cache')).viewStateCache;
}

beforeEach(() => { localStorage.clear(); ipc.save.mockClear(); ipc.del.mockClear(); errors.mockClear(); });
afterEach(() => { delete (window as unknown as Record<string, unknown>).guguFirstFrame; });

describe('caps', () => {
  it('the worst case of every model together stays under the budget the first frame reads synchronously', () => {
    const total = VIEW_STATE_MODELS.reduce((sum, model) => sum + model.maxBytes, 0);
    expect(total).toBeLessThanOrEqual(VIEW_STATE_BUDGET_BYTES);
  });

  it('every key written today belongs to exactly the model meant for it', () => {
    const cases: Record<string, string> = {
      navigation: 'navigation', sidebar: 'sidebar', 'project:p1': 'project view', 'session:s1': 'task view',
      'session:s1:tabs': 'task tabs', 'chat:c1:tabs': 'chat tabs', 'view:a/c1/draft': 'draft', 'view:a/task:local/s1/draft': 'draft',
      'view:a/c1/reading:chat:c1': 'reading position', 'view:a/c1/reading:chat:c1:topic': 'reading position', 'view:a/c1/members': 'members panel',
    };
    for (const [key, name] of Object.entries(cases)) {
      expect(viewStateModelOf(key)?.name, key).toBe(name);
      expect(VIEW_STATE_MODELS.filter((model) => model.match.test(key)), key).toHaveLength(1);
    }
  });

  it('a model over its count drops its least recently written entry, here and in storage; other models are untouched', async () => {
    const cache = await start({});
    const max = viewStateModelOf('chat:x:tabs')!.maxEntries;
    for (let i = 0; i < max; i++) cache.write(`chat:c${i}:tabs`, { i });
    cache.write('view:a/c/members', { query: 'other model' });
    cache.write('chat:c0:tabs', { i: 0, again: true });
    expect(ipc.del, 'at the cap, not over it').not.toHaveBeenCalled();
    cache.write(`chat:c${max}:tabs`, { i: max });
    expect(cache.read('chat:c0:tabs'), 'written again: among the newest').toEqual({ i: 0, again: true });
    expect(cache.read('chat:c1:tabs'), 'the least recently written').toBeUndefined();
    expect(ipc.del.mock.calls.map(([key]) => key)).toEqual(['chat:c1:tabs']);
    expect(cache.read('view:a/c/members')).toEqual({ query: 'other model' });
    expect(cache.keys('chat:')).toHaveLength(max);
  });

  it('one long entry is stored whole (a 3100-character draft); over the model total the oldest entries go first', async () => {
    const cache = await start({});
    const { maxBytes } = viewStateModelOf('view:a/c/draft')!;
    const long = { text: '长'.repeat(3100), mentions: [] };
    cache.write('view:a/c0/draft', { text: 'oldest', mentions: [] });
    cache.write('view:a/c1/draft', { text: 'older', mentions: [] });
    cache.write('view:a/c2/draft', long);
    expect(ipc.save).toHaveBeenLastCalledWith('view:a/c2/draft', long);
    expect(ipc.del, 'well under the total: nothing goes').not.toHaveBeenCalled();
    // Sizes count the key too (15 characters here): this one puts the model 70 over, which the two small drafts cover.
    const big = { text: 'x'.repeat(maxBytes - JSON.stringify(long).length - 74), mentions: [] };
    cache.write('view:a/c3/draft', big);
    expect(ipc.del.mock.calls.map(([key]) => key), 'the oldest until it fits').toEqual(['view:a/c0/draft', 'view:a/c1/draft']);
    expect(cache.read('view:a/c2/draft')).toEqual(long);
    expect(cache.read('view:a/c3/draft')).toEqual(big);
  });

  it('an entry over its whole model total is not stored: logged once, kept in memory, and its last stored copy stays', async () => {
    const cache = await start({});
    const { maxBytes } = viewStateModelOf('view:a/c/members')!;
    cache.write('view:a/c/members', { query: 'short' });
    cache.write('view:a/c/members', { query: 'x'.repeat(maxBytes) });
    cache.write('view:a/c/members', { query: 'x'.repeat(maxBytes + 1) });
    expect(cache.read('view:a/c/members')).toEqual({ query: 'x'.repeat(maxBytes + 1) });
    expect(ipc.save).toHaveBeenCalledTimes(1);
    expect(ipc.del).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith('view state entry over its cap; kept in memory, the last stored copy stays', expect.objectContaining({ model: 'members panel' }));
  });

  it('a key no model claims is refused', async () => {
    const cache = await start({});
    expect(() => cache.write('mystery', 1)).toThrow(/belongs to no model/);
  });
});

describe('the first frame', () => {
  it('desktop: everything main handed preload is there before any read, held to the caps; writes go to main at once', async () => {
    const max = viewStateModelOf('view:a/c/draft')!.maxEntries;
    const snapshot: Record<string, unknown> = { 'chat:legacy': { old: true }, navigation: { currentViewId: 'home' } };
    for (let i = 0; i <= max; i++) snapshot[`view:a/c${i}/draft`] = { text: `d${i}` };
    const cache = await start(snapshot);
    expect(cache.read('navigation')).toEqual({ currentViewId: 'home' });
    expect(cache.read('view:a/c0/draft'), 'the oldest of a model over its count, written before caps existed').toBeUndefined();
    expect(cache.read(`view:a/c${max}/draft`)).toEqual({ text: `d${max}` });
    expect(cache.read('chat:legacy'), 'no model claims it').toBeUndefined();
    expect(ipc.del.mock.calls.map(([key]) => key).sort()).toEqual(['chat:legacy', 'view:a/c0/draft']);
    expect(ipc.save, 'what came from main is not sent back').not.toHaveBeenCalled();
    cache.write('view:a/c1/draft', { text: 'typed just before a quit' });
    expect(ipc.save).toHaveBeenCalledWith('view:a/c1/draft', { text: 'typed just before a quit' });
  });

  it('desktop with nothing from main: says so, starts empty, still writes', async () => {
    const cache = await start(null);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/no view state/));
    cache.write('sidebar', { folds: [] });
    expect(ipc.save).toHaveBeenCalledWith('sidebar', { folds: [] });
  });

  it('web and phone: localStorage, read back in write order at the next start', async () => {
    let cache = await start();
    cache.write('view:a/c1/draft', { text: 'one' });
    cache.write('view:a/c2/draft', { text: 'two' });
    cache.write('view:a/c1/draft', { text: 'one again' });
    expect(ipc.save).not.toHaveBeenCalled();
    cache = await start();
    expect(cache.keys('view:a/')).toEqual(['view:a/c2/draft', 'view:a/c1/draft']);
    expect(cache.read('view:a/c1/draft')).toEqual({ text: 'one again' });
  });
});
