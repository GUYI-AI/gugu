import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarkSeenWhenShown } from './use-mark-seen-when-shown';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
function Probe({ session, shown }: { session: { seen: boolean; markSeen: () => void | Promise<boolean> }; shown: boolean }) {
  useMarkSeenWhenShown(session, shown);
  return null;
}

describe('useMarkSeenWhenShown: unread / needs-you is cleared only on screen', () => {
  beforeEach(() => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a hidden retained page leaves an unseen session alone, and marks it seen once shown', () => {
    const session = { seen: false, markSeen: vi.fn() };
    act(() => root.render(<Probe session={session} shown={false} />));
    expect(session.markSeen).toHaveBeenCalledTimes(0);
    act(() => root.render(<Probe session={session} shown />));
    expect(session.markSeen).toHaveBeenCalledTimes(1);
  });
  it('retries a failed host acknowledgement only while the page stays shown', async () => {
    vi.useFakeTimers();
    const session = { seen: false, markSeen: vi.fn().mockResolvedValue(false) };
    await act(async () => root.render(<Probe session={session} shown />));
    expect(session.markSeen).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(session.markSeen).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Probe session={session} shown={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(session.markSeen).toHaveBeenCalledTimes(2);
  });
});
