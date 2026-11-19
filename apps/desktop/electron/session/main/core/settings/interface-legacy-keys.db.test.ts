import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!h.db) throw new Error('fixture not open'); return h.db; } }));
vi.mock('@main/core/agents/plugin-registry', () => ({ isValidProviderId: () => true }));
import { SettingsStore } from './settings-service';
import { getDefaultForKey } from './settings-registry';

let fixture: Awaited<ReturnType<typeof openFixture>>;
afterEach(() => { fixture?.close(); h.db = undefined; });

const stored = () =>
  (fixture.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('interface') as { value: string } | undefined)?.value;

// #2548 the removed sidebar switch: dev databases still hold `{"desktopSidebarV2":true}` in the interface row.
describe('a removed interface key left in the database', () => {
  it('reads, starts and writes as before; the next write drops the key', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('interface', JSON.stringify({ desktopSidebarV2: true, chatView: 'single' }));
    const settings = new SettingsStore();
    await settings.initialize();

    const value = await settings.get('interface');
    expect(value.chatView).toBe('single');
    expect(value.confirmBeforeArchive).toBe(getDefaultForKey('interface').confirmBeforeArchive);
    expect((await settings.getWithMeta('interface')).value.chatView).toBe('single');

    // The renderer writes back the whole value it read (stale key included); the write is not refused.
    await settings.update('interface', { ...value, confirmBeforeArchive: false });
    expect(JSON.parse(stored()!)).toEqual({ chatView: 'single', confirmBeforeArchive: false });
    expect(await settings.get('interface')).not.toHaveProperty('desktopSidebarV2');
  });

  it('a row holding only the removed key is deleted by the next write at defaults', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('interface', JSON.stringify({ desktopSidebarV2: true }));
    const settings = new SettingsStore();
    await settings.update('interface', await settings.get('interface'));
    expect(stored()).toBeUndefined();
  });
});
