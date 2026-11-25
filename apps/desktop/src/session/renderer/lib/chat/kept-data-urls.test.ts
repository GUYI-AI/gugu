import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_URL_KEEP_CHARS, forgetKeptDataUrls, keptDataUrl } from './kept-data-urls';

const picture = (chars: number) => `data:image/png;base64,${'A'.repeat(chars)}`;

describe('keptDataUrl', () => {
  afterEach(forgetKeptDataUrls);

  it('reads a picture once while it is kept', async () => {
    const read = vi.fn(async () => picture(10));
    expect(await keptDataUrl('a', read)).toBe(picture(10));
    expect(await keptDataUrl('a', read)).toBe(picture(10));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps at most DATA_URL_KEEP_CHARS: drawing many pictures lets the least recently drawn go', async () => {
    const quarter = DATA_URL_KEEP_CHARS / 4;
    const reads = new Map<string, number>();
    const draw = (key: string) => keptDataUrl(key, async () => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return picture(quarter);
    });
    for (const key of ['a', 'b', 'c']) await draw(key);
    await draw('a'); // drawn again: now the most recent
    await draw('d'); // four quarters plus their headers do not fit: 'b', the least recently drawn, goes
    await draw('a');
    await draw('c');
    expect(reads.get('a'), 'drawn recently: kept').toBe(1);
    expect(reads.get('c'), 'kept until it was the oldest').toBe(1);
    await draw('b');
    expect(reads.get('b'), 'let go, so read again').toBe(2);
    // A hundred pictures later the first ones are read again: nothing holds them all.
    for (let i = 0; i < 100; i++) await draw(`many-${i}`);
    await draw('many-0');
    expect(reads.get('many-0')).toBe(2);
    expect(reads.get('many-99')).toBe(1);
  });

  it('does not keep a read that found nothing or failed', async () => {
    const empty = vi.fn(async () => null);
    await keptDataUrl('none', empty);
    await keptDataUrl('none', empty);
    expect(empty).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async (): Promise<string | null> => { throw new Error('unreadable'); });
    await expect(keptDataUrl('bad', failing)).rejects.toThrow('unreadable');
    await expect(keptDataUrl('bad', failing)).rejects.toThrow('unreadable');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
