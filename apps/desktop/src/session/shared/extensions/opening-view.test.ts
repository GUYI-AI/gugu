import { beforeEach, expect, it, vi } from 'vitest';
import { boxOnWindow, OPEN_AMONG_MAX, openingViewOf } from './app-runtime-protocol';

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id, chat_id: CHAT, kind: 'file', filename: `${id}.png`, content_type: 'image/png', size_bytes: 8, version: 2, parent_id: null, path: `${id}.png`, ...extra,
});
let listed: Record<string, unknown>[] = [];
const rpc = vi.fn((_name: string, _args: Record<string, unknown>) => {
  const result = Promise.resolve({ data: listed, error: null });
  return Object.assign(result, { select: vi.fn(() => result) });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }), hasCapability: () => true,
  sync: {} as never, claimant: () => null, identities: async () => [], faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn(),
} as never);
beforeEach(() => { rpc.mockClear(); listed = []; });

it('keeps only the clicked file\'s own place among what a page showed, in its order', () => {
  const among = [{ id: 'a', chat: CHAT }, { id: 'b' }, { id: 'c', chat: 'another' }, { id: 'w', workspace: 'ws' }, { id: 'b' }, 'x', null, { id: 'd', chat: CHAT }];
  expect(openingViewOf({ id: 'b', chat: CHAT }, { among })).toEqual({ among: ['a', 'b', 'd'] });
  expect(openingViewOf({ workspace: 'ws', id: 'w' }, { among: [...among, { id: 'v', workspace: 'ws' }] })).toEqual({ among: ['w', 'v'] });
  // Not among them, or alone: nothing to page through.
  expect(openingViewOf({ id: 'z' }, { among })).toEqual({});
  expect(openingViewOf({ id: 'a' }, { among: [{ id: 'a' }] })).toEqual({});
});

it('keeps the files nearest the clicked one past the limit', () => {
  const among = Array.from({ length: OPEN_AMONG_MAX * 2 }, (_, n) => ({ id: `f${n}` }));
  const kept = openingViewOf({ id: 'f550' }, { among }).among!;
  expect(kept).toHaveLength(OPEN_AMONG_MAX);
  expect([kept[0], kept.at(-1)]).toEqual(['f300', 'f799']);
  expect(openingViewOf({ id: 'f2' }, { among }).among![0]).toBe('f0');
  expect(openingViewOf({ id: 'f990' }, { among }).among!.at(-1)).toBe('f999');
});

it('takes a box of four finite numbers with a size, and places it on the window only inside its frame', () => {
  expect(openingViewOf({ id: 'a' }, { origin: { x: 10, y: 20, width: 30, height: 40 } })).toEqual({ origin: { x: 10, y: 20, width: 30, height: 40 } });
  for (const origin of [{ x: 1, y: 2, width: 0, height: 4 }, { x: Number.NaN, y: 2, width: 3, height: 4 }, { x: '1', y: 2, width: 3, height: 4 }, null]) {
    expect(openingViewOf({ id: 'a' }, { origin })).toEqual({});
  }
  const frame = { left: 100, top: 50, width: 400, height: 300 };
  expect(boxOnWindow({ x: 10, y: 20, width: 30, height: 40 }, frame)).toEqual({ x: 110, y: 70, width: 30, height: 40 });
  expect(boxOnWindow({ x: -20, y: 280, width: 40, height: 40 }, frame)).toEqual({ x: 80, y: 330, width: 40, height: 40 });
  expect(boxOnWindow({ x: 500, y: 20, width: 30, height: 40 }, frame)).toBeUndefined();
});

it('pages only through readable images of the chat, from one listing, and none when the clicked one is not one', async () => {
  listed = [image('a'), image('b'), image('doc', { kind: 'document', filename: 'n.md', content_type: 'text/markdown' }), image('heic', { filename: 'x.heic', content_type: 'image/heic' }),
    image('gone', { availability: 'expired' }), image('machine', { host_device_id: 'device' }), image('d')];
  await expect(files.viewedAmong(CHAT, 'b', ['d', 'doc', 'b', 'heic', 'gone', 'machine', 'nowhere', 'a'])).resolves.toEqual([
    { itemId: 'd', version: 2, name: 'd.png', contentType: 'image/png' },
    { itemId: 'b', version: 2, name: 'b.png', contentType: 'image/png' },
    { itemId: 'a', version: 2, name: 'a.png', contentType: 'image/png' },
  ]);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_list_as']);
  await expect(files.viewedAmong(CHAT, 'doc', ['a', 'doc', 'b'])).resolves.toEqual([]);
  await expect(files.viewedAmong(CHAT, 'a', ['b', 'd'])).resolves.toEqual([]);
});

it('reads the listing while the file is read, again for the file\'s own chat, and opens alone when it fails', async () => {
  const { viewedAmongOf } = await import('./app-files-core');
  const image = { itemId: 'b', version: 2, name: 'b.png', contentType: 'image/png' };
  const viewed = vi.fn(async (_chat: string, _item: string, _ids: readonly string[]) => [image]);
  const among = viewedAmongOf(viewed, { chatId: CHAT, itemId: 'b', among: ['a', 'b'] });
  expect(viewed).toHaveBeenCalledWith(CHAT, 'b', ['a', 'b']);
  await expect(among({ chatId: CHAT, itemId: 'b' }, { kind: 'none' })).resolves.toEqual([image]);
  expect(viewed).toHaveBeenCalledTimes(1);
  // A topic's file is its source's: the listing of that chat.
  await expect(among({ chatId: 'source', itemId: 'b' }, { kind: 'none' })).resolves.toEqual([image]);
  expect(viewed).toHaveBeenLastCalledWith('source', 'b', ['a', 'b']);
  // An App claims it: nothing to page through.
  await expect(among({ chatId: CHAT, itemId: 'b' }, { kind: 'one' })).resolves.toEqual([]);
  // Not named by the page: nothing read.
  viewed.mockClear();
  await expect(viewedAmongOf(viewed, { itemId: 'b' })({ chatId: CHAT, itemId: 'b' }, { kind: 'none' })).resolves.toEqual([]);
  expect(viewed).not.toHaveBeenCalled();
  const failing = viewedAmongOf(async () => { throw new Error('offline'); }, { chatId: CHAT, itemId: 'b', among: ['a', 'b'] });
  await expect(failing({ chatId: CHAT, itemId: 'b' }, { kind: 'none' })).resolves.toEqual([]);
});
