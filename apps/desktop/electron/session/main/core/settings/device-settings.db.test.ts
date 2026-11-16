import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined, userData: '' }));
vi.mock('@main/db/client', () => ({ get db() { if (!h.db) throw new Error('fixture not open'); return h.db; } }));
vi.mock('@main/core/agents/plugin-registry', () => ({ isValidProviderId: () => true }));
vi.mock('electron', () => ({ app: { getPath: () => h.userData }, nativeTheme: { shouldUseDarkColors: false } }));
import { SettingsStore } from './settings-service';
import { answerDeviceSettings, hostPreferencesNow } from './device-settings';
import { themeSchema } from './schema';
import { resolveEffectiveTheme } from '../pty/terminal-color-scheme';

/**
 * @@@device-preferences — preload's one request before the first frame: the old localStorage values main adopts (the
 * upgrade start) and the settings it hands over. Main's own value always wins; an old key is settled (preload deletes it)
 * either way.
 */
let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(() => { h.userData = mkdtempSync(join(tmpdir(), 'gugu-device-settings-')); });
afterEach(() => {
  fixture?.close();
  h.db = undefined;
  rmSync(h.userData, { recursive: true, force: true });
});

const row = (key: string) =>
  (fixture.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

const pack = {
  id: 'obsidian:someone/paper',
  name: 'Paper',
  modes: { light: { bg: '#fbf7ef', fg: '#2b2a28' } },
  source: { kind: 'obsidian', url: 'https://github.com/someone/paper', author: 'someone', license: '' },
};

describe('device settings handover', () => {
  it('upgrade start: main has nothing, the old values are adopted and handed over, every old key is settled', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    const store = new SettingsStore();
    const answer = answerDeviceSettings({
      theme: 'dark',
      locale: 'en-US',
      sidebarTint: 'true',
      trayBadge: 'false',
      chatNotifications: JSON.stringify({ messages: false, requests: true }),
      meetingReminder: 'off',
      hiddenIdeasEntries: ['assistant-1'],
      themePackSlots: JSON.stringify({ light: pack.id }),
      importedThemePacks: JSON.stringify([pack]),
    }, store);

    expect(new Set(answer.settled)).toEqual(new Set([
      'theme', 'locale', 'sidebarTint', 'trayBadge', 'chatNotifications', 'meetingReminder', 'hiddenIdeasEntries', 'themePackSlots', 'importedThemePacks',
    ]));
    const settings = answer.handover.settings;
    expect(settings.theme.value).toBe('dark');
    expect(settings.locale.value).toBe('en-US');
    expect(settings.interface.value).toMatchObject({ sidebarTint: true, trayBadge: false });
    expect(settings.chatNotifications.value).toEqual({ chatMessages: false, sound: true });
    expect(settings.assistant.value).toEqual({ meetingReminder: false, hiddenIdeasEntries: ['assistant-1'] });
    expect(settings.themePackSlots.value).toEqual({ light: pack.id });
    // The imported pack moved into main's file; the stylesheet is derived from it.
    expect(JSON.parse(readFileSync(join(h.userData, 'theme-packs', 'imported.json'), 'utf8'))).toEqual([pack]);
    expect(answer.handover.themePackCss).toContain(":root[data-theme='light']");
    // Stored as main's own now: the next start needs no old key.
    expect(JSON.parse(row('theme')!)).toBe('dark');
    expect(JSON.parse(row('interface')!)).toMatchObject({ sidebarTint: true, trayBadge: false });
    expect(answerDeviceSettings({}, store).handover.settings.theme.value).toBe('dark');
  });

  it('main already has a value and an old key is left: main wins, the old key is settled (deleted by preload)', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('theme', JSON.stringify('system'));
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('interface', JSON.stringify({ sidebarTint: true }));
    mkdirSync(join(h.userData, 'theme-packs'), { recursive: true });
    writeFileSync(join(h.userData, 'theme-packs', 'imported.json'), '[]');
    const store = new SettingsStore();
    const answer = answerDeviceSettings({ theme: 'dark', sidebarTint: 'false', importedThemePacks: JSON.stringify([pack]) }, store);
    expect(new Set(answer.settled)).toEqual(new Set(['theme', 'sidebarTint', 'importedThemePacks']));
    expect(answer.handover.settings.theme.value).toBe('system');
    expect(answer.handover.settings.interface.value).toMatchObject({ sidebarTint: true });
    expect(JSON.parse(row('theme')!)).toBe('system');
    expect(readFileSync(join(h.userData, 'theme-packs', 'imported.json'), 'utf8')).toBe('[]');
  });

  it('an old value that says nothing usable is dropped (settled), ❌ written', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    const answer = answerDeviceSettings({ theme: 'sepia', locale: 'fr-FR' }, new SettingsStore());
    expect(new Set(answer.settled)).toEqual(new Set(['theme', 'locale']));
    expect(row('theme')).toBeUndefined();
    expect(answer.handover.settings.theme.value).toBe('light');
    expect(answer.handover.settings.locale.value).toBe('system');
  });
});

describe('a broken imported theme file', () => {
  it('loses only the colours: theme and language are still handed over for the first frame', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    const store = new SettingsStore();
    answerDeviceSettings({ theme: 'dark', locale: 'en-US' }, store);
    mkdirSync(join(h.userData, 'theme-packs'), { recursive: true });
    writeFileSync(join(h.userData, 'theme-packs', 'imported.json'), '{ not json');
    const answer = answerDeviceSettings({}, store);
    expect(answer.handover.settings.theme.value).toBe('dark');
    expect(answer.handover.settings.locale.value).toBe('en-US');
    expect(answer.handover.themePackCss).toBe('');
  });
});

describe('the theme setting has a writer now', () => {
  it('reads values stored before it had one, and the terminal colour scheme follows the choice', () => {
    expect(themeSchema.parse('emdark')).toBe('dark');
    expect(themeSchema.parse('emlight')).toBe('light');
    expect(themeSchema.parse(null)).toBe('light');
    // The choice wins over the OS appearance (off macOS nothing else carries it to the terminal).
    expect(resolveEffectiveTheme('dark', false)).toBe('emdark');
    expect(resolveEffectiveTheme('light', true)).toBe('emlight');
    expect(resolveEffectiveTheme('system', true)).toBe('emdark');
  });
});

describe('main applies theme and language from its own settings (@@@device-preferences)', () => {
  it('reads both from the settings, an adopted old value included; nothing stored = the factory values', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    const store = new SettingsStore();
    expect(hostPreferencesNow(store)).toEqual({ theme: 'light', locale: 'system', trayBadge: true });
    answerDeviceSettings({ theme: 'dark', locale: 'en-US' }, store);
    expect(hostPreferencesNow(store)).toEqual({ theme: 'dark', locale: 'en-US', trayBadge: true });
    await store.update('theme', 'system');
    await store.update('locale', 'zh-CN');
    expect(hostPreferencesNow(store)).toEqual({ theme: 'system', locale: 'zh-CN', trayBadge: true });
    // The tray badge is read with them (one read, before the contents load).
    answerDeviceSettings({ trayBadge: 'false' }, new SettingsStore());
    expect(hostPreferencesNow(store).trayBadge).toBe(false);
  });

  it('a value stored before the theme key had its writer reads as what it meant', async () => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('theme', JSON.stringify('emdark'));
    expect(hostPreferencesNow(new SettingsStore()).theme).toBe('dark');
  });
});
