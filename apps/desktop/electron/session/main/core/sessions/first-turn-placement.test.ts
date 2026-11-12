import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => new Map<number, EventEmitter & { isDestroyed(): boolean }>());
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => windows.get(id) } }));

import {
  firstTurnFilesPlaced, firstTurnPlacement, holdFirstTurnForPlacement, releasePlacementsOf,
} from './first-turn-placement';

const WINDOW = 7;
const LINE = 1_000_042;
const settled = async (wait: Promise<void> | null) => {
  if (!wait) return true;
  let done = false;
  void wait.then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  return done;
};
const window = () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  windows.set(WINDOW, contents);
  return contents;
};

describe('#2558 a first turn queued while its files are still being placed', () => {
  beforeEach(() => {
    windows.clear();
    for (const sender of [WINDOW, LINE]) releasePlacementsOf(sender);
  });

  it('nothing placing: the dispatch goes on at once', async () => {
    expect(await settled(firstTurnPlacement('task', new AbortController().signal))).toBe(true);
  });

  it('waits until the creating page says placement settled, then goes on', async () => {
    holdFirstTurnForPlacement('task', LINE);
    const wait = firstTurnPlacement('task', new AbortController().signal);
    expect(await settled(wait)).toBe(false);
    firstTurnFilesPlaced('task');
    expect(await settled(wait)).toBe(true);
    expect(await settled(firstTurnPlacement('task', new AbortController().signal)), 'settled once is settled').toBe(true);
  });

  it('a stop ends the wait (the dispatch then refuses before any byte)', async () => {
    holdFirstTurnForPlacement('task', LINE);
    const stop = new AbortController();
    const wait = firstTurnPlacement('task', stop.signal);
    stop.abort();
    expect(await settled(wait)).toBe(true);
    expect(await settled(firstTurnPlacement('task', new AbortController().signal)), 'the placement itself still holds').toBe(false);
  });

  it('a network line that closes takes its placements with it; another line\'s keep waiting', async () => {
    holdFirstTurnForPlacement('mine', LINE);
    holdFirstTurnForPlacement('theirs', LINE + 1);
    const mine = firstTurnPlacement('mine', new AbortController().signal);
    const theirs = firstTurnPlacement('theirs', new AbortController().signal);
    releasePlacementsOf(LINE);
    expect(await settled(mine)).toBe(true);
    expect(await settled(theirs)).toBe(false);
    releasePlacementsOf(LINE + 1);
  });

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])('a window of this app whose page is gone (%s) lets the turn go', async (event) => {
    const contents = window();
    holdFirstTurnForPlacement('task', WINDOW);
    const wait = firstTurnPlacement('task', new AbortController().signal);
    expect(await settled(wait)).toBe(false);
    contents.emit(event);
    expect(await settled(wait)).toBe(true);
    expect(contents.listenerCount('destroyed') + contents.listenerCount('render-process-gone') + contents.listenerCount('did-navigate')).toBe(0);
  });

  it('a window that is already gone when the hold is asked for holds nothing', async () => {
    holdFirstTurnForPlacement('task', WINDOW);
    expect(await settled(firstTurnPlacement('task', new AbortController().signal))).toBe(true);
  });
});
