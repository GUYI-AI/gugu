import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => null }));

const { firstRunAtBoot } = await import('./first-run-apps');

// 复评 10-16: first-run at boot belongs to the desktop and 咕咕 server (both boot with `browserFeatures`). The web build's
// headless host reads the desktop's own profile — before this it started a go on the desktop's record. bootSessionHostCore
// calls `noteProfile` first thing and `start` once the Apps are up; both go through this one gate.
function steps() {
  return { note: vi.fn(), start: vi.fn(async () => undefined) };
}

describe('first-run at boot (firstRunAtBoot)', () => {
  it('the desktop and 咕咕 server: the profile is noted, and the go started', () => {
    const s = steps();
    const firstRun = firstRunAtBoot(true, s);
    firstRun.noteProfile('/profile');
    firstRun.start();
    expect(s.note).toHaveBeenCalledWith('/profile');
    expect(s.start).toHaveBeenCalledTimes(1);
  });

  it("the web build's headless host: neither — first-run is the desktop's", () => {
    const s = steps();
    const firstRun = firstRunAtBoot(false, s);
    firstRun.noteProfile('/profile');
    firstRun.start();
    expect(s.note).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
  });

  it('after the set\'s go — even a failed one — the assistant App check runs (#1931)', async () => {
    const order: string[] = [];
    const ensure = vi.fn(async () => { order.push('ensure'); });
    firstRunAtBoot(true, { note: vi.fn(), start: vi.fn(async () => { order.push('set'); throw new Error('offline'); }), ensure }).start();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    expect(order).toEqual(['set', 'ensure']);
  });

  it('a profile that cannot be noted is said in the log; the boot goes on', () => {
    const s = { note: vi.fn(() => { throw new Error('first-run-apps.json is malformed'); }), start: vi.fn(async () => undefined) };
    expect(() => firstRunAtBoot(true, s).noteProfile('/profile')).not.toThrow();
  });
});
