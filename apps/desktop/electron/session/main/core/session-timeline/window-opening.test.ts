import { describe, expect, it, vi } from 'vitest';
import { createWindowOpenings } from './window-opening';
import { createWindowCommitRuntime } from './window-commit-runtime';

function fixture(capture: (conversationId: string) => Promise<(() => boolean) | null> = vi.fn(async () => () => true)) {
  const runtime = createWindowCommitRuntime({ persist: vi.fn(async () => {}),
    capture: () => { throw new Error('No turn is produced by opening history'); }, project: vi.fn(), report: vi.fn() });
  const reserve = vi.fn((input: typeof inputValue, failed: Parameters<typeof runtime.reserve>[2]) => runtime.reserve(input.subscriptionId, input.conversationId, failed));
  const owners = new Map<string, { stop(): void }>();
  const book = createWindowOpenings({ capture, reserve, register: (id, owner) => {
    owners.get(id)?.stop(); owners.set(id, owner);
    return () => { if (owners.get(id) === owner) owners.delete(id); };
  } });
  return { book, owners, capture, reserve, runtime };
}
const inputValue = { conversationId: 'session', subscriptionId: 'unique-opening' }, input = inputValue;
describe('host-owned stopped history preparations', () => {
  it('uses the same conversation and UUID exactly once without sending a runtime proof to the client', async () => {
    const { book, owners } = fixture();
    expect(await book.prepare(input)).toMatchObject({ source: 'window', liveCursor: { sequence: 0 } });
    expect(() => book.take({ ...input, conversationId: 'another-session' })).toThrow(/no stopped history proof/);
    const validate = book.take(input); owners.get(input.subscriptionId)!.stop();
    expect(() => validate()).not.toThrow();
    expect(() => book.take(input)).toThrow(/no stopped history proof/);
  });
  it('selects legacy before reading when the host does not have a stopped proof', async () => {
    const { book, owners } = fixture(vi.fn(async () => null));
    expect(await book.prepare(input)).toEqual({ source: 'legacy' });
    expect(owners.size).toBe(0);
  });
  it('invalidates a proof after runtime ABA instead of changing history sources', async () => {
    let version = 0;
    const { book } = fixture(vi.fn(async () => { const opened = version; return () => version === opened; }));
    await book.prepare(input); version += 2;
    expect(() => book.take(input)).toThrow(expect.objectContaining({ code: 'scope_changed' }));
  });
  it('does not restore a released preparation when its capture finishes late', async () => {
    let release!: (proof: () => boolean) => void;
    const { book, owners } = fixture(vi.fn(() => new Promise<() => boolean>(yes => { release = yes; })));
    const preparing = book.prepare(input);
    owners.get(input.subscriptionId)!.stop(); release(() => true);
    await expect(preparing).rejects.toMatchObject({ code: 'unsubscribed' });
    expect(() => book.take(input)).toThrow(/no stopped history proof/);
    expect(owners.size).toBe(0);
  });
  it('bounds retained preparations and admits a new one after release', async () => {
    const { book, owners } = fixture();
    for (let index = 0; index < 32; index += 1) await book.prepare({ ...input, subscriptionId: String(index) });
    await expect(book.prepare(input)).rejects.toMatchObject({ code: 'window_capacity' });
    owners.get('0')!.stop();
    await expect(book.prepare(input)).resolves.toMatchObject({ source: 'window', liveCursor: { sequence: 0 } });
  });
  it('reserves synchronously before lifecycle capture and releases an abandoned cold preparation', async () => {
    const pending = Promise.withResolvers<() => boolean>(), f = fixture(() => pending.promise);
    const preparing = f.book.prepare(input);
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.runtime.inspect().owners).toBe(1);
    f.owners.get(input.subscriptionId)!.stop(); expect(f.runtime.inspect().owners).toBe(0);
    pending.resolve(() => true); await expect(preparing).rejects.toMatchObject({ code: 'unsubscribed' });
  });
  it('transfers the original live cursor and pending read without letting the retired preparation disposer close it', async () => {
    const f = fixture(), result = await f.book.prepare(input);
    if (result.source !== 'window') throw new Error('Expected window');
    const opening = f.book.take(input), read = opening.live.read(result.liveCursor);
    const rejected = expect(read).rejects.toMatchObject({ code: 'unsubscribed' });
    f.owners.get(input.subscriptionId)!.stop(); expect(f.runtime.inspect().owners).toBe(1);
    opening.live.authorize(); opening.live.close(); await rejected; expect(f.runtime.inspect().owners).toBe(0);
  });
  it('keeps pre-read legacy selection when the new producer is unavailable and emits no window failure', async () => {
    const f = fixture(async () => null), failed = vi.fn();
    f.reserve.mockImplementationOnce(() => { throw new Error('Producer unavailable'); });
    expect(await f.book.prepare(input, failed)).toEqual({ source: 'legacy' });
    expect(failed).not.toHaveBeenCalled(); expect(f.runtime.inspect().owners).toBe(0);
  });
  it('reports a prepared lease failure once, settles its empty read, and never restores its proof', async () => {
    const f = fixture(), failed = vi.fn(), result = await f.book.prepare(input, failed);
    if (result.source !== 'window') throw new Error('Expected window');
    const opening = f.book.take(input, failed), read = opening.live.read(result.liveCursor);
    const rejected = expect(read).rejects.toMatchObject({ code: 'live_source_gap' });
    f.runtime.invalidate(); f.runtime.invalidate(); await rejected;
    expect(failed).toHaveBeenCalledTimes(1); expect(f.runtime.inspect().owners).toBe(0);
    expect(() => f.book.take(input)).toThrow('no stopped history proof');
  });
});
