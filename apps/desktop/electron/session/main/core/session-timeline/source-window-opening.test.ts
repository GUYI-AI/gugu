import { describe, expect, it, vi } from 'vitest';

// A failed opening of the source-window reader must not stay cached: the next read opens it again.
const fixture = vi.hoisted(() => ({ getPathCalls: 0 }));
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      fixture.getPathCalls += 1;
      if (fixture.getPathCalls === 1) throw new Error('userData not ready');
      return '/tmp/gugu-source-window-test';
    },
  },
}));
vi.mock('./desktop-source-reader', () => ({
  createDesktopSourceWindowReader: () => ({ snapshot: async () => ({ opened: true }) }),
}));

import { windowSnapshot } from './service';

describe('source window opening', () => {
  it('opens again after a failed first opening', async () => {
    const first = await windowSnapshot({ conversationId: 'c1' });
    expect(first).toEqual({ ok: false, error: { code: 'record_unreadable', message: 'userData not ready' } });
    const second = await windowSnapshot({ conversationId: 'c1' });
    expect(second).toEqual({ ok: true, value: { opened: true } });
    expect(fixture.getPathCalls).toBe(2);
  });
});
