import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined, errors: [] as unknown[][] }));
vi.mock('@main/db/client', () => ({ get db() { if (!h.db) throw new Error('fixture not open'); return h.db; } }));
vi.mock('@main/core/agents/plugin-registry', () => ({ isValidProviderId: () => true }));
vi.mock('@main/lib/logger', () => ({ log: { error: (...args: unknown[]) => h.errors.push(args), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { SettingsStore } from './settings-service';
import { answerDevicePreferences, onDevicePreferencesChanged } from './device-preferences';
import { DEVICE_PREFERENCES_FACTORY } from '../../../../../shared/device-preferences';

let fixture: Awaited<ReturnType<typeof openFixture>>;
afterEach(() => { fixture?.close(); h.db = undefined; h.errors.length = 0; });

async function open(kind: 'empty' = 'empty'): Promise<SettingsStore> {
  fixture = await openFixture(kind); h.db = fixture.db;
  return new SettingsStore();
}
const row = () => (fixture.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('devicePreferences') as { value: string } | undefined)?.value;

describe('the first-frame answer moves the old localStorage keys into main once', () => {
  it('adopts the old values, tells the host, and settles every key', async () => {
    const store = await open();
    const told: unknown[] = [];
    const stop = onDevicePreferencesChanged((preferences) => told.push(preferences));
    const answer = answerDevicePreferences({ theme: 'dark', sidebarTint: 'true', trayBadge: 'false', chatNotifications: '{"messages":false}' }, store);
    stop();
    const expected = { ...DEVICE_PREFERENCES_FACTORY, theme: 'dark', sidebarTint: true, trayBadge: false, chatMessages: false };
    expect(answer.devicePreferences).toEqual(expected);
    expect(answer.settled.sort()).toEqual(['chatNotifications', 'sidebarTint', 'theme', 'trayBadge']);
    expect(told).toEqual([expected]);
    expect((await store.get('devicePreferences')).theme).toBe('dark');
  });

  it('a start after the move: nothing sent, nothing written, the stored value answered', async () => {
    const store = await open();
    answerDevicePreferences({ locale: 'en-US' }, store);
    const before = row();
    const answer = answerDevicePreferences({}, store);
    expect(answer).toEqual({ devicePreferences: { ...DEVICE_PREFERENCES_FACTORY, locale: 'en-US' }, settled: [] });
    expect(row()).toBe(before);
  });

  it('runs once: keys that come again after the move (their deletion never reached the disk) are deleted, not read', async () => {
    const store = await open();
    answerDevicePreferences({ theme: 'dark' }, store);
    // Since the move the person picked light (the factory value: no field stored), then the app was killed.
    await store.update('devicePreferences', DEVICE_PREFERENCES_FACTORY);
    const answer = answerDevicePreferences({ theme: 'dark' }, store);
    expect(answer).toEqual({ devicePreferences: DEVICE_PREFERENCES_FACTORY, settled: ['theme'] });
  });

  it("main's own value wins over a leftover key", async () => {
    const store = await open();
    await store.update('devicePreferences', { ...DEVICE_PREFERENCES_FACTORY, theme: 'system' });
    const answer = answerDevicePreferences({ theme: 'dark' }, store);
    expect(answer.devicePreferences.theme).toBe('system');
    expect(answer.settled).toEqual(['theme']);
  });

  it('an unreadable old value is said, dropped, and leaves the setting as it was', async () => {
    const store = await open();
    const answer = answerDevicePreferences({ theme: 'sepia', chatNotifications: '{broken' }, store);
    expect(answer.devicePreferences).toEqual(DEVICE_PREFERENCES_FACTORY);
    expect(answer.settled.sort()).toEqual(['chatNotifications', 'theme']);
    expect(h.errors.map(([message, fields]) => [message, (fields as { name: string }).name]).sort()).toEqual([
      [expect.stringContaining('unreadable'), 'chatNotifications'],
      [expect.stringContaining('unreadable'), 'theme'],
    ]);
    expect(row()).toBeUndefined();
  });

  it('without a settings table yet (the first start, before its migrations) nothing is settled: the keys stay', async () => {
    const store = await open();
    fixture.sqlite.prepare('DROP TABLE app_settings').run();
    expect(answerDevicePreferences({ theme: 'dark' }, store)).toEqual({ devicePreferences: DEVICE_PREFERENCES_FACTORY, settled: [] });
  });

  it('a write that fails throws (the caller answers null and the keys stay)', async () => {
    const store = await open();
    vi.spyOn(store, 'updateNow').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => answerDevicePreferences({ theme: 'dark' }, store)).toThrow('disk full');
    // Nothing recorded: the next start moves the keys again.
    vi.mocked(store.updateNow).mockRestore();
    expect(answerDevicePreferences({ theme: 'dark' }, store).devicePreferences.theme).toBe('dark');
  });
});
