import { describe, expect, it, vi } from 'vitest';
import { createWindowOpenings } from './window-opening';

function fixture(capture: (conversationId: string) => Promise<(() => boolean) | null> = vi.fn(async () => () => true)) {
  const owners = new Map<string, { stop(): void }>();
  const book = createWindowOpenings({ capture, register: (id, owner) => {
    owners.get(id)?.stop(); owners.set(id, owner);
    return () => { if (owners.get(id) === owner) owners.delete(id); };
  } });
  return { book, owners, capture };
}
const input = { conversationId: 'session', subscriptionId: 'unique-opening' };
describe('host-owned stopped history preparations', () => {
  it('uses the same conversation and UUID exactly once without sending a runtime proof to the client', async () => {
    const { book, owners } = fixture();
    expect(await book.prepare(input)).toEqual({ source: 'window' });
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
    expect(book.take(input)).toThrow(expect.objectContaining({ code: 'scope_changed' }));
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
    await expect(book.prepare(input)).resolves.toEqual({ source: 'window' });
  });
});
