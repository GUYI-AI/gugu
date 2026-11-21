import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SettingsNav } from '@/components/settings/SettingsNav';
import type { AuthUser } from '@/store/auth';
import { SETTINGS_SECTIONS, type ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels';
import { i18n } from '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/components/settings/settings.css';
import '@/styles/tokens.css';

const tourFixture = vi.hoisted(() => ({ value: null as null | { step: 'contacts'; status: 'skipped' } }));
vi.mock('@/lib/productTour', async original => ({ ...await original<object>(), useProductTourState: () => ({ state: 'value', value: tourFixture.value, stale: false, error: null }) }));
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>();
  return { ...actual, platform: { ...actual.platform, kind: 'electron' } };
});

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/deviceProjects', async (original) => ({ ...await original<object>(), listMyDeviceProjects: async () => ({}) }));
vi.mock('@/store/devicesRead', () => ({ readDevices: async () => [] }));
// File storage is a key of the account's own settings row (lib/ownSettings): an empty row = the defaults.
vi.mock('@gugu/core/cloud/userSettings', async (original) => ({ ...await original<object>(), readUserSettingsConfig: async () => ({}) }));
vi.mock('@/lib/fileStorage', async (original) => {
  const { DEFAULT_FILE_STORAGE } = await import('@gugu/core/shared/fileStorage');
  return {
    ...await original<object>(),
    readFileStorage: async () => ({ ...DEFAULT_FILE_STORAGE }),
    readFileStorageOverview: async () => ({
      total_bytes: 0, count: 0, expiring_7d_bytes: 0,
      classes: { temporary: { bytes: 0, count: 0 }, image: { bytes: 0, count: 0 }, kept: { bytes: 0, count: 0 } },
      groups: [], expiring: [], machines: [],
    }),
  };
});
const { SettingsPanel } = await import('@/components/SettingsPanel');

// Apps and Phone are specific to the phone shell.
const desktopSections = SETTINGS_SECTIONS.filter((section) => section !== 'apps' && section !== 'phone' && section !== 'connectors');
const nickname = '一个名称很长但仍能完整访问的验收账号';
const user: AuthUser = { id: 'settings-7333', nickname, gugu_number: 7333, email: 'settings@example.com' };
let harness: ReturnType<typeof createReactHarness>;
let previousTheme: string | undefined;
function NavHost() {
  const [section, setSection] = useState<ActiveSection>('general');
  return <SettingsNav user={user} sections={desktopSections} activeSection={section} onSelect={setSection} />;
}
const tier = (element: Element) => {
  const style = getComputedStyle(element);
  return [Number.parseFloat(style.fontSize), Number.parseFloat(style.lineHeight), style.fontWeight];
};
beforeEach(async () => {
  tourFixture.value = null;
  await page.viewport(1200, 900);
  await i18n.changeLanguage('zh-CN');
  // Production Vite supplies this build constant; keep the real About section in this test.
  vi.stubGlobal('__APP_VERSION__', 'test-version');
  previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  harness.container.style.cssText = 'display:flex;width:216px;height:760px;';
});
afterEach(() => {
  harness.cleanup();
  vi.unstubAllGlobals();
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

describe('settings navigation hierarchy and interaction (#7333)', () => {
  it('help in settings preserves resume progress and owns the only settings feedback entry', async () => {
    tourFixture.value = { step: 'contacts', status: 'skipped' };
    await renderWithAppProviders(harness, <SettingsPanel initialSection="help" onClose={vi.fn()} />, { auth: user, contacts: {} });
    const card = document.querySelector<HTMLElement>('[data-settings-modal-card]')!;
    await until('the help page shows the saved third tour step', () => card.querySelector('[data-testid="help-tour-resume"]')?.textContent?.includes('3 / 6') === true);
    expect(card.querySelector('[data-testid="settings-nav-help"]')?.getAttribute('aria-current')).toBe('page');
    expect(card.querySelectorAll('[data-testid="about-feedback"]')).toHaveLength(1);
    if (import.meta.env.VITE_HELP_SETTINGS_CAPTURE === '1') {
      const dialog = card.closest<HTMLElement>('[role="dialog"]')!;
      await until('the help settings renderer is stable', () => dialog.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished'));
      await page.screenshot({ element: dialog, path: '__screenshots__/help-settings/with-resume-and-feedback.png' });
    }
    await userEvent.click(card.querySelector<HTMLElement>('[data-testid="settings-nav-about"]')!);
    await until('About is selected after moving feedback', () => card.dataset.settingsSection === 'about');
    expect(card.querySelector('[data-testid="about-feedback"]')).toBeNull();
    await userEvent.click(card.querySelector<HTMLElement>('[data-testid="settings-nav-help"]')!);
    await until('returning to help retains the original resume step', () => card.querySelector('[data-testid="help-tour-resume"]')?.textContent?.includes('3 / 6') === true);
  });

  it('subscriptions has one shell heading while its refresh action stays available', async () => {
    await renderWithAppProviders(harness, <SettingsPanel initialSection="subscriptions" onClose={vi.fn()} />, { auth: null, contacts: {} });
    const detail = document.querySelector<HTMLElement>('[data-settings-modal-card] [data-role="detail"]')!;
    await until('the real subscriptions content and refresh action loaded', () => detail.querySelector('[data-testid="subscriptions-refresh"]') !== null);
    expect(detail.querySelectorAll('h2')).toHaveLength(1);
    expect(detail.querySelector('h2')?.textContent).toBe(i18n.t('settings.nav.subscriptions', { ns: 'main' }));
    expect(detail.querySelector('[data-slot="page-title-row"]')).toBeNull();
    if (import.meta.env.VITE_SUBSCRIPTIONS_HEADER_CAPTURE === '1') {
      const dialog = detail.closest<HTMLElement>('[role="dialog"]')!;
      await until('the isolated renderer settings dialog is stable', () => dialog.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished'));
      await page.screenshot({ element: dialog, path: '__screenshots__/subscriptions-single-heading/after-light.png' });
    }
  });

  it.each(['light', 'dark'])('the full desktop menu fits the normal dialog height with one restrained current item in %s', async (theme) => {
    document.documentElement.dataset.theme = theme;
    await renderWithAppProviders(harness, <NavHost />);
    const pane = harness.container.querySelector<HTMLElement>('[data-slot="pane"][data-role="nav"]')!;
    const scroll = pane.querySelector<HTMLElement>('.gg-settings-nav-scroll')!;
    const rows = pane.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]');
    expect(pane.getBoundingClientRect().width).toBe(216);
    expect(rows).toHaveLength(17);
    expect([...rows].map((row) => row.dataset.testid)).toEqual([
      'settings-nav-account', 'settings-nav-subscriptions', 'settings-nav-usage',
      'settings-nav-general', 'settings-nav-data-import', 'settings-nav-interface', 'settings-nav-model', 'settings-nav-permissions', 'settings-nav-passwords',
      'settings-nav-sessions', 'settings-nav-prompts', 'settings-nav-devices', 'settings-nav-browser', 'settings-nav-files',
      'settings-nav-resource-monitor', 'settings-nav-help', 'settings-nav-about',
    ]);
    expect(pane.querySelector('[data-testid="settings-nav-permissions"]')?.textContent).toBe('本机控制');
    expect(pane.querySelector('[data-testid="settings-nav-passwords"]')?.textContent).toBe('密码');
    expect(pane.querySelector('[data-testid="settings-nav-activity"]')).toBeNull();
    expect(pane.querySelectorAll('[data-testid="settings-nav-usage"]')).toHaveLength(1);
    expect(pane.querySelector('[data-testid="settings-nav-resource-monitor"]')?.textContent).toBe('资源监视器');
    expect(scroll.clientHeight).toBeGreaterThan(600);
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
    expect(pane.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const current = pane.querySelector<HTMLElement>('[data-testid="settings-nav-general"]')!;
    const ordinary = pane.querySelector<HTMLElement>('[data-testid="settings-nav-browser"]')!;
    expect(current.getBoundingClientRect().height).toBe(32);
    expect(tier(current.querySelector('.gg-list-row-title')!)).toEqual([14, 20, '500']);
    expect(tier(ordinary.querySelector('.gg-list-row-title')!)).toEqual([14, 20, '400']);
    expect(ordinary.querySelector('svg')!.getBoundingClientRect().width).toBe(16);
    expect(getComputedStyle(current).backgroundColor).not.toBe(getComputedStyle(ordinary).backgroundColor);
    const identity = pane.querySelector<HTMLElement>('.gg-settings-identity')!;
    const name = identity.querySelector<HTMLElement>('.gg-settings-identity-name')!;
    expect(identity.getBoundingClientRect().height).toBeLessThanOrEqual(60);
    expect(tier(name)).toEqual([14, 20, '500']);
    expect(name.title).toBe(nickname);
    expect(name.clientWidth).toBeGreaterThan(80);
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(tier(identity.querySelector('.gg-settings-identity-id')!)).toEqual([12, 18, '400']);
  });

  it('replaces the subscription row with Team for a team identity even with a broad section allowlist', async () => {
    await renderWithAppProviders(harness, <SettingsNav user={{ ...user, accountKind: 'team_member' }} sections={desktopSections}
      activeSection="team" onSelect={vi.fn()} />);
    const rows = harness.container.querySelectorAll('[data-testid^="settings-nav-"]');
    expect(rows).toHaveLength(17);
    const team = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-team"]')!;
    expect(team).not.toBeNull();
    expect(team.getAttribute('aria-current')).toBe('page');
    expect(harness.container.querySelector('[data-testid="settings-nav-subscriptions"]')).toBeNull();
    harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-account"]')!.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(team);
  });

  it('the real navigation responds to keyboard and copy keeps the original number', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await renderWithAppProviders(harness, <NavHost />);
    const account = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-account"]')!;
    account.focus();
    await userEvent.keyboard('{Enter}');
    await until('Enter changes the active section', () => account.getAttribute('aria-current') === 'page');
    await userEvent.tab();
    const subscriptions = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-subscriptions"]')!;
    expect(document.activeElement).toBe(subscriptions);
    expect(subscriptions.matches(':focus-visible')).toBe(true);
    expect(getComputedStyle(subscriptions).outlineStyle).toBe('solid');
    await userEvent.keyboard(' ');
    await until('Space changes the active section', () => subscriptions.getAttribute('aria-current') === 'page');
    expect(account.hasAttribute('aria-current')).toBe(false);
    await userEvent.tab();
    const usage = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-usage"]')!;
    expect(document.activeElement).toBe(usage);
    await userEvent.keyboard('{Enter}');
    await until('Enter opens Usage after Subscriptions', () => usage.getAttribute('aria-current') === 'page');
    const browser = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-browser"]')!;
    browser.focus();
    await userEvent.tab();
    const files = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-files"]')!;
    expect(document.activeElement).toBe(files);
    await userEvent.keyboard('{Enter}');
    await until('Enter opens File storage after Browser in Work', () => files.getAttribute('aria-current') === 'page');
    await page.getByRole('button', { name: i18n.t('actions.copy'), exact: true }).click();
    expect(copy).toHaveBeenCalledExactlyOnceWith('7333');
  });

  it('the phone Me list retains full-sized rows, its back action and unselected navigation', async () => {
    await page.viewport(412, 820);
    harness.container.style.width = '412px';
    const onSelect = vi.fn();
    const onBack = vi.fn();
    await renderWithAppProviders(harness, <SettingsNav user={user} sections={['account', 'general', 'about']} activeSection="general" mobile onSelect={onSelect} onBack={onBack} />);
    const rows = harness.container.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(row.hasAttribute('aria-current')).toBe(false);
    }
    await page.getByRole('button', { name: i18n.t('settings.nav.general', { ns: 'main' }), exact: true }).click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('general');
    await page.getByRole('button', { name: i18n.t('settings.back', { ns: 'main' }), exact: true }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each(['navigation', 'deep-link'] as const)('opens the unchanged file-storage page directly through %s', async (entry) => {
    await renderWithAppProviders(harness, <SettingsPanel initialSection={entry === 'deep-link' ? 'files' : 'general'} onClose={vi.fn()} />, { auth: user, contacts: {} });
    const card = document.querySelector<HTMLElement>('[data-settings-modal-card]')!;
    const files = card.querySelector<HTMLElement>('[data-testid="settings-nav-files"]')!;
    if (entry === 'navigation') await userEvent.click(files);
    await until('existing FileStorageSection loaded directly', () => card.querySelector('[data-testid="settings-file-storage"]') !== null);
    expect(card.dataset.settingsSection).toBe('files');
    expect(files.getAttribute('aria-current')).toBe('page');
    const detail = card.querySelector<HTMLElement>('[data-role="detail"]')!;
    expect(detail.querySelector('[data-slot="pane-header"] h2')?.textContent).toBe(i18n.t('settings.nav.files', { ns: 'main' }));
    expect(detail.querySelector('#settings-kept-retention')).not.toBeNull();
    expect(detail.querySelector('[data-slot="pane-header"]')?.textContent).not.toContain(i18n.t('settings.nav.devices', { ns: 'main' }));
    expect(detail.querySelector(`[aria-label="${i18n.t('settings.back', { ns: 'main' })}"]`)).toBeNull();
    await userEvent.click(card.querySelector<HTMLElement>('[data-testid="settings-nav-devices"]')!);
    await until('Devices opens without the old subpage', () => card.dataset.settingsSection === 'devices');
    expect(card.querySelector('[data-testid="settings-file-storage-entry"]')).toBeNull();
    expect(card.querySelector('[data-testid="settings-file-storage"]')).toBeNull();
  });

  it.each([1200, 900])('the real settings panel aligns every page heading with its reading column at %ipx', async (width) => {
    await page.viewport(width, 900);
    await renderWithAppProviders(harness, <SettingsPanel initialSection="general" onClose={vi.fn()} />, { auth: null, contacts: {} });
    const detail = document.querySelector<HTMLElement>('[data-settings-modal-card] [data-role="detail"]')!;
    const dialog = detail.closest<HTMLElement>('[role="dialog"]')!;
    await until('the real settings dialog finished entering', () => dialog.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    const verify = () => {
      const title = detail.querySelector<HTMLElement>('[data-slot="pane-header"] h2')!;
      // A session-page section sits in a display: contents wrapper; its own element is the column.
      const column = detail.querySelector<HTMLElement>('.gg-settings-body [data-session-settings-section]') ?? detail.querySelector<HTMLElement>('.gg-settings-body > *')!;
      expect(detail.getBoundingClientRect().width).toBeGreaterThan(550);
      expect(column.getBoundingClientRect().width).toBeGreaterThan(500);
      expect(column.getBoundingClientRect().width).toBeLessThanOrEqual(720);
      expect(title.getBoundingClientRect().left).toBeCloseTo(column.getBoundingClientRect().left, 0);
      expect(tier(title)).toEqual([20, 28, '600']);
    };
    verify();
    await page.getByRole('button', { name: i18n.t('settings.nav.about', { ns: 'main' }), exact: true }).click();
    await until('About opens in the same dialog', () => !detail.isConnected || document.querySelector('[data-settings-modal-card]')?.getAttribute('data-settings-section') === 'about');
    expect(detail.isConnected, 'navigating to About must not unmount the settings panel').toBe(true);
    verify();
    await page.getByRole('button', { name: i18n.t('settings.nav.subscriptions', { ns: 'main' }), exact: true }).click();
    await until('Subscriptions (drawn by the session page) opens in the same dialog', () => detail.querySelector('[data-session-settings-section="subscriptions"] [data-testid="subscriptions-refresh"]') !== null);
    verify();
    expect(document.querySelectorAll('[data-settings-modal-card]')).toHaveLength(1);
  });
});
