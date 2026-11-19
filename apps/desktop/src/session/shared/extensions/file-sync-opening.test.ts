import { afterEach, expect, it, vi } from 'vitest';
import { encodeAuthFrame } from './app-runtime-protocol';
import { FileSyncRelay, type SocketEvents } from './file-sync-core';

function connection(seconds = 3600) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({ sub: 'person', exp: Date.now() / 1000 + seconds })}.sig`;
  let arrived!: (events: SocketEvents) => void;
  const connected = new Promise<SocketEvents>((resolve) => { arrived = resolve; });
  const close = vi.fn();
  const connect = vi.fn((_url: string, _protocols: string[], events: SocketEvents) => {
    arrived(events);
    return { send: vi.fn(), close, ping: () => false, terminate: vi.fn() };
  });
  const readToken = vi.fn(async () => token);
  const relay = new FileSyncRelay({
    serviceUrl: () => 'wss://files.invalid', token: readToken, connect,
    hasCapability: () => true, warn: vi.fn(),
  });
  return { relay, connected, connect, close, readToken };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('opens one shared connection before a guest exists and reuses it for its grant', async () => {
  vi.useFakeTimers();
  const c = connection();
  c.relay.ensureFor(null);
  c.relay.ensureFor(null);
  const events = await c.connected;
  events.open();
  const page = c.relay.attachPage(1, 'workspace', { post: vi.fn(), close: vi.fn() });
  c.relay.grant(page, { docName: 'item@0', itemId: 'item', access: 'rw', needs: null });
  c.relay.fromPage(page, encodeAuthFrame('item@0\0provider', '').slice().buffer);
  expect(c.connect).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(c.close).not.toHaveBeenCalled();
  c.relay.pageGone(page.id);
  vi.advanceTimersByTime(30_000);
  expect(c.close).toHaveBeenCalledWith(1000, 'idle');
});

it('uses the existing idle deadline when opening is cancelled before any guest claims it', async () => {
  vi.useFakeTimers();
  const c = connection();
  c.relay.ensureFor(null);
  (await c.connected).open();
  vi.advanceTimersByTime(30_000);
  expect(c.close).toHaveBeenCalledWith(1000, 'idle');
});

it('stored range lifetimes use page revocation/removal, not a document epoch reopening', async () => {
  vi.useFakeTimers();
  const c = connection(), released = vi.fn();
  c.relay.onPageRelease(released);
  c.relay.attachPage(2, 'reader', { post: vi.fn(), close: vi.fn() });
  await c.relay.revoke(2, null); expect(released).not.toHaveBeenCalled();
  const predicate = () => true;
  await c.relay.revoke(2, 'unbound', predicate); expect(released).toHaveBeenLastCalledWith(2, predicate);
  await c.relay.revoke(2, 'removed-from-group'); expect(released).toHaveBeenLastCalledWith(2, undefined);
  c.relay.pageGone(2); expect(released).toHaveBeenLastCalledWith(2);
  expect(released).toHaveBeenCalledTimes(3);
});

it('keeps a near-expiry token connection through repeated opens without creating idle replacements', async () => {
  vi.useFakeTimers();
  const c = connection(9 * 60);
  c.relay.ensureFor(null);
  (await c.connected).open();
  const page = c.relay.attachPage(3, 'workspace', { post: vi.fn(), close: vi.fn() });
  c.relay.grant(page, { docName: 'item@0', itemId: 'item', access: 'rw', needs: null });
  c.relay.fromPage(page, encodeAuthFrame('item@0\0provider', '').slice().buffer);
  const socket = page.keys.get('item@0\0provider');
  for (let round = 0; round < 10; round++) {
    expect(c.relay.ensureFor(null)).toBe(socket);
    await vi.advanceTimersByTimeAsync(30_000);
  }
  expect(c.connect).toHaveBeenCalledOnce();
  expect(c.close).not.toHaveBeenCalled();
  expect(socket?.owners.size).toBe(1);
});

it('uses the refreshed account token after actual expiry and preserves files on the old connection', async () => {
  vi.useFakeTimers();
  const c = connection(60);
  c.relay.ensureFor(null);
  (await c.connected).open();
  const page = c.relay.attachPage(4, 'workspace', { post: vi.fn(), close: vi.fn() });
  c.relay.grant(page, { docName: 'item@0', itemId: 'item', access: 'rw', needs: null });
  c.relay.fromPage(page, encodeAuthFrame('item@0\0old', '').slice().buffer);
  const old = page.keys.get('item@0\0old');
  await vi.advanceTimersByTimeAsync(59_000);
  expect(c.relay.ensureFor(null)).toBe(old);
  expect(c.connect).toHaveBeenCalledOnce();
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const fresh = `${encode({ alg: 'none' })}.${encode({ sub: 'person', exp: Date.now() / 1000 + 3600 })}.sig`;
  c.readToken.mockResolvedValue(fresh);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(c.relay.ensureFor(null)).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.connect).toHaveBeenCalledTimes(2);
  expect(c.connect.mock.calls[1]?.[1]).toContain(`bearer.${fresh}`);
  c.connect.mock.calls[1]?.[2].open();
  c.relay.fromPage(page, encodeAuthFrame('item@0\0new', '').slice().buffer);
  expect(page.keys.get('item@0\0new')).not.toBe(old);
  expect(old?.owners.size).toBe(1);
  expect(c.close).not.toHaveBeenCalled();
});
