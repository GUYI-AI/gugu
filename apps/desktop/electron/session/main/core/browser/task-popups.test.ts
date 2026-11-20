import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPopups } from '../../../../server/task-popups';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('windows a page opened that wait for the tab that shows them', () => {
  it('hands a window to the first tab that opens its address, once', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('https://auth.test/login?x=1', 'P1');
    expect(popups.take('https://auth.test/other')).toBeNull();
    expect(popups.take('https://auth.test/login?x=1')).toBe('P1');
    expect(popups.take('https://auth.test/login?x=1')).toBeNull();
  });

  it('matches an address however it is written, but not a different query', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('https://Auth.test', 'P1');
    expect(popups.take('https://auth.test/')).toBe('P1');
    popups.hold('https://auth.test/cb?a=1&b=2', 'P2');
    expect(popups.take('https://auth.test/cb?a=1')).toBeNull();
    expect(popups.take('https://auth.test/cb?a=1&b=2')).toBe('P2');
  });

  it('gives windows of the same address out in the order they were opened', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('https://auth.test/', 'P1');
    popups.hold('https://auth.test/', 'P2');
    expect([popups.take('https://auth.test/'), popups.take('https://auth.test/')]).toEqual(['P1', 'P2']);
  });

  it('takes an empty window for a tab that opens about:blank, and nothing for a tab without an address', () => {
    const popups = new TaskPopups(vi.fn());
    popups.hold('about:blank', 'P1');
    expect(popups.take(undefined)).toBeNull();
    expect(popups.take('about:blank')).toBe('P1');
  });

  it('closes a window nobody took after a few seconds, and not one that was taken', () => {
    const close = vi.fn();
    const popups = new TaskPopups(close);
    popups.hold('https://a.test/', 'P1');
    popups.hold('https://b.test/', 'P2');
    expect(popups.take('https://a.test/')).toBe('P1');
    vi.advanceTimersByTime(4_900);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(close.mock.calls).toEqual([['P2']]);
    expect(popups.take('https://b.test/')).toBeNull();
  });

  it('forgets a window Chrome closed, and stops waiting when disposed', () => {
    const close = vi.fn();
    const popups = new TaskPopups(close);
    popups.hold('https://a.test/', 'P1');
    popups.hold('https://b.test/', 'P2');
    popups.forget('P1');
    expect(popups.take('https://a.test/')).toBeNull();
    popups.dispose();
    vi.advanceTimersByTime(10_000);
    expect(close).not.toHaveBeenCalled();
    expect(popups.take('https://b.test/')).toBeNull();
  });
});
