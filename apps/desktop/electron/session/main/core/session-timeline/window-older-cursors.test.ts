import { describe, expect, it } from 'vitest';
import { createWindowOlderCursors } from './window-older-cursors';

const binding = { conversationId: 'c', sessionId: 's', scope: 'a'.repeat(64), branchLineage: 'branch' };
describe('host-owned opaque historical cursor capabilities', () => {
  it('keeps only current and previous positions, replaying a lost response without advancing or inventing an anchor', () => {
    const store = createWindowOlderCursors(), owner = {}, first = store.prepare(owner, binding, { kind: 'canonical', beforeStoredSeq: 100 });
    expect(first.cursorRef).toMatch(/^older:[a-f0-9-]{36}$/);
    const second = store.advance(owner, binding, first.cursorRef, { kind: 'canonical', beforeStoredSeq: 92 })!;
    expect(store.read(owner, binding, first.cursorRef)).toEqual({ kind: 'canonical', beforeStoredSeq: 100 });
    expect(store.advance(owner, binding, first.cursorRef, { kind: 'canonical', beforeStoredSeq: 92 })).toBe(second);
    expect(store.advance(owner, binding, first.cursorRef, { kind: 'canonical', beforeStoredSeq: 91 })).toBeNull();
    const third = store.advance(owner, binding, second, { kind: 'canonical', beforeStoredSeq: 84 })!;
    expect(store.read(owner, binding, first.cursorRef)).toBeNull();
    expect(store.read(owner, binding, third)).toEqual({ kind: 'canonical', beforeStoredSeq: 84 });
  });

  it('binds every ref to the real owner, conversation, session, branch, and scope', () => {
    const store = createWindowOlderCursors(), owner = {}, first = store.prepare(owner, binding, { kind: 'canonical', beforeStoredSeq: null });
    expect(store.read({}, binding, first.cursorRef)).toBeNull();
    for (const changed of [{ ...binding, conversationId: 'other' }, { ...binding, sessionId: 'other' },
      { ...binding, branchLineage: 'other' }, { ...binding, scope: 'b'.repeat(64) }]) expect(store.read(owner, changed, first.cursorRef)).toBeNull();
    expect(store.read(owner, binding, 'older:guessed')).toBeNull();
  });

  it('isolates old disposers from a replacement owner binding and returns only scalar snapshots', () => {
    const store = createWindowOlderCursors(), owner = {}, start = { kind: 'canonical' as const, beforeStoredSeq: 3 };
    const old = store.prepare(owner, binding, start); start.beforeStoredSeq = 0;
    expect(store.read(owner, binding, old.cursorRef)).toEqual({ kind: 'canonical', beforeStoredSeq: 3 });
    const fresh = store.prepare(owner, binding, { kind: 'native', locatorRef: 'actual-host-native-locator' }); old.release();
    expect(store.read(owner, binding, old.cursorRef)).toBeNull();
    expect(store.read(owner, binding, fresh.cursorRef)).toEqual({ kind: 'native', locatorRef: 'actual-host-native-locator' });
    fresh.release(); expect(store.read(owner, binding, fresh.cursorRef)).toBeNull();
    const other = {}, otherRef = store.prepare(other, binding, { kind: 'canonical', beforeStoredSeq: null });
    store.close(owner); expect(store.read(other, binding, otherRef.cursorRef)).not.toBeNull(); store.close(other);
    expect(store.read(other, binding, otherRef.cursorRef)).toBeNull();
  });
});
