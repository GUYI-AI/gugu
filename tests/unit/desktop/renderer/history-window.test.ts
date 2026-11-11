// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext, type TranscriptTurn } from '@gugu/session-chat-ui';
import { HistoryWindow, type StoredPage } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/history-window';

/**
 * A history window shows a stretch of stored history around a turn far above the loaded transcript, and pages both
 * ways from there. What is pinned: it opens on the turn asked for, it never shows a history with a hole in it, and it
 * knows when it has reached the conversation's newest stored turn.
 */
const turn = (seq: number): TranscriptTurn => ({ id: `s:turn:s${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `s:turn:s${seq}:u`, seq: 0, role: 'user', text: `ask ${seq}` }] } as TranscriptTurn);

/** A store of `count` turns whose pages hold at most `fits` turns: the newest ones before the cursor, like the real read. */
function stored(count: number, fits: number) {
  const read = vi.fn(async (before: number): Promise<StoredPage | null> => {
    const end = Math.min(before, count), start = Math.max(0, end - fits);
    return { turns: Array.from({ length: Math.max(0, end - start) }, (_unused, index) => turn(start + index)), nextCursor: start > 0 ? start : null };
  });
  return { read, newestStored: () => count - 1 };
}

const context = createChatContext({ locale: () => 'en-US' });
const opened: HistoryWindow[] = [];
/** Opened, and with the turns below its first page read (the window reads them at once). */
const open = async (source: ReturnType<typeof stored>, seq: number) => {
  const window = await HistoryWindow.open({ context, uri: 's', seq, ...source });
  if (window) opened.push(window);
  await window?.settled();
  return window;
};
const seqs = (window: HistoryWindow) => window.turns.map(one => one.seq);
afterEach(() => { opened.splice(0).forEach(window => window.dispose()); });

describe('a history window', () => {
  it('opens on the turn asked for, with a few turns below it', async () => {
    const source = stored(3000, 100);
    const window = (await open(source, 1200))!;
    // What it is shown with: the page that reaches a few turns below the target.
    expect(source.read.mock.calls[0]).toEqual([1209]);
    expect(seqs(window).slice(0, 100)).toEqual(Array.from({ length: 100 }, (_unused, index) => 1109 + index));
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(true);
  });

  // A first page that does not fill the viewport cannot be scrolled, so reaching its end would never ask for more.
  it('reads the turns below its first page at once, without being asked', async () => {
    const source = stored(3000, 100);
    const window = (await open(source, 1200))!;
    expect(source.read.mock.calls.map(([before]) => before)).toEqual([1209, 1289]);
    expect(seqs(window)).toEqual(Array.from({ length: 180 }, (_unused, index) => 1109 + index));
  });

  it('reads the page that ends at the turn when reaching below it cut the turn out', async () => {
    // Pages of five: the eight turns below the target fill the page, and the target is not in it.
    const source = stored(3000, 5);
    const window = (await HistoryWindow.open({ context, uri: 's', seq: 1200, ...source }))!;
    opened.push(window);
    expect(source.read.mock.calls.slice(0, 2).map(([before]) => before)).toEqual([1209, 1201]);
    expect(seqs(window)).toEqual([1196, 1197, 1198, 1199, 1200]);
    // The window is one small page; the turns below it arrive without the reader having to reach its end.
    await window.settled();
    expect(seqs(window)).toEqual(Array.from({ length: 85 }, (_unused, index) => 1196 + index));
  });

  it('does not open on a turn that is not stored', async () => {
    expect(await open(stored(100, 50), 500)).toBeNull();
  });

  it('pages up from its oldest turn, and says when the history starts', async () => {
    const window = (await open(stored(3000, 100), 150))!;
    expect(seqs(window)[0]).toBe(59);
    expect((await window.loadOlder()).map(one => one.seq)).toEqual(Array.from({ length: 59 }, (_unused, index) => index));
    expect(window.hasOlder).toBe(false);
    expect(await window.loadOlder()).toEqual([]);
  });

  it('pages down without a hole when a read comes back cut short of the window', async () => {
    // Reaching eighty turns below, in pages of thirty: three reads meet the window before anything is appended.
    const source = stored(3000, 30);
    const window = (await open(source, 1200))!;
    const newest = seqs(window).at(-1)!;
    source.read.mockClear();
    const appended = await window.loadNewer();
    expect(appended.map(one => one.seq)).toEqual(Array.from({ length: 80 }, (_unused, index) => newest + 1 + index));
    expect(source.read.mock.calls.map(([before]) => before)).toEqual([newest + 81, newest + 51, newest + 21]);
    const held = seqs(window);
    expect(held).toEqual(Array.from({ length: held.length }, (_unused, index) => held[0]! + index));
  });

  it('stops at the newest stored turn', async () => {
    const source = stored(1250, 100);
    const window = (await HistoryWindow.open({ context, uri: 's', seq: 1200, ...source }))!;
    opened.push(window);
    await window.settled();
    expect(seqs(window).slice(-41)).toEqual(Array.from({ length: 41 }, (_unused, index) => 1209 + index));
    expect(window.hasNewer).toBe(false);
    source.read.mockClear();
    expect(await window.loadNewer()).toEqual([]);
    expect(source.read).not.toHaveBeenCalled();
  });

  it('appends nothing when a page on the way cannot be read', async () => {
    const source = stored(3000, 30);
    const window = (await open(source, 1200))!;
    const before = seqs(window);
    source.read.mockResolvedValueOnce({ turns: [turn(1280), turn(1281)], nextCursor: 1280 }).mockResolvedValueOnce(null);
    expect(await window.loadNewer()).toEqual([]);
    expect(seqs(window)).toEqual(before);
  });

  it('reads above and below at the same time', async () => {
    const source = stored(3000, 100);
    const window = (await open(source, 1200))!;
    source.read.mockClear();
    const [above, below] = await Promise.all([window.loadOlder(), window.loadNewer()]);
    expect(above).toHaveLength(100);
    expect(below).toHaveLength(80);
  });

  it('reads one page at a time', async () => {
    const source = stored(3000, 100);
    const window = (await open(source, 1200))!;
    source.read.mockClear();
    const [first, second] = await Promise.all([window.loadOlder(), window.loadOlder()]);
    expect(source.read).toHaveBeenCalledOnce();
    expect(first).toHaveLength(100);
    expect(second).toEqual([]);
  });
});
