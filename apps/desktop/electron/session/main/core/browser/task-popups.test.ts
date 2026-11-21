import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPopups } from '../../../../server/task-popups';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('windows a page opened that wait for the tab that shows them', () => {
  it('hands a window to the tab that asks for it by its id, once', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('P1');
    expect(popups.take('P2')).toBe(false);
    expect(popups.take(undefined)).toBe(false);
    expect(popups.take('P1')).toBe(true);
    expect(popups.take('P1')).toBe(false);
  });

  it('keeps windows apart whatever their address is: every one is its own id', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('P1');
    popups.hold('P2');
    expect([popups.take('P2'), popups.take('P1'), popups.take('P2')]).toEqual([true, true, false]);
  });

  it('closes a window nobody took after a few seconds, and not one that was taken', () => {
    const close = vi.fn();
    const popups = new TaskPopups(close);
    popups.hold('P1');
    popups.hold('P2');
    expect(popups.take('P1')).toBe(true);
    vi.advanceTimersByTime(4_900);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(close.mock.calls).toEqual([['P2']]);
    expect(popups.take('P2')).toBe(false);
  });

  it('remembers a window that closed itself before any tab took it, so the tab opened for it knows there is nothing to show', () => {
    const close = vi.fn();
    const popups = new TaskPopups(close);
    popups.hold('P1');
    popups.forget('P1'); // The page called window.close() already.
    expect(popups.take('P1')).toBe(false);
    expect(popups.closedBeforeTaken('P2')).toBe(false);
    expect(popups.closedBeforeTaken(undefined)).toBe(false);
    expect(popups.closedBeforeTaken('P1')).toBe(true);
    expect(popups.closedBeforeTaken('P1')).toBe(false); // Told once.
    expect(close).not.toHaveBeenCalled();
  });

  it('does not remember a window Gugu closed because nobody took it, or one that was taken, or one told long after', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('P1');
    vi.advanceTimersByTime(6_000); // Unclaimed: closed by Gugu.
    popups.forget('P1');
    expect(popups.closedBeforeTaken('P1')).toBe(false);
    popups.hold('P2');
    expect(popups.take('P2')).toBe(true);
    popups.forget('P2');
    expect(popups.closedBeforeTaken('P2')).toBe(false);
    popups.hold('P3');
    popups.forget('P3');
    vi.advanceTimersByTime(11_000);
    expect(popups.closedBeforeTaken('P3')).toBe(false);
  });

  it('forgets a window Chrome closed, and stops waiting when disposed', () => {
    const close = vi.fn();
    const popups = new TaskPopups(close);
    popups.hold('P1');
    popups.hold('P2');
    popups.dispose();
    vi.advanceTimersByTime(10_000);
    expect(close).not.toHaveBeenCalled();
    expect(popups.take('P2')).toBe(false);
  });
});
