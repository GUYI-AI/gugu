import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { i18n, setLocalePreference } from '@/i18n';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { KeyboardShortcutsCheatSheet } from '@renderer/features/settings/components/keyboard-shortcuts-cheat-sheet';
import KeyboardSettingsCard from '@renderer/features/settings/components/KeyboardSettingsCard';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMainCatalog';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { useAppSettingsKey: () => fakeAppSettings({}) };
});
vi.mock('@renderer/features/settings/use-terminal-enabled', async original => {
  const { readValue } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { ...(await original<object>()), useTerminalEnabled: () => readValue(false) };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const previousLocale = i18n.language === 'en-US' ? 'en-US' : 'zh-CN';
const previousTheme = document.documentElement.dataset.theme;
const previousClass = document.body.className;
afterEach(() => {
  modalStore.closeModal();
  root?.unmount(); host?.remove(); root = null; host = null;
  setLocalePreference(previousLocale);
  document.body.className = previousClass;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
});

async function prepare(locale: 'zh-CN' | 'en-US', theme: 'light' | 'dark', width: number) {
  await page.viewport(width, 900);
  setLocalePreference(locale);
  document.documentElement.dataset.theme = theme;
  document.body.classList.add('gugu-skin', theme === 'dark' ? 'emdark' : 'emlight');
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
}
function render(theme: 'light' | 'dark', children: ReactNode) {
  root!.render(<QueryClientProvider client={new QueryClient()}><SessionLocalizationProvider><SessionUiTheme theme={theme}>{children}</SessionUiTheme></SessionLocalizationProvider></QueryClientProvider>);
}
async function settled() {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
}

for (const locale of ['zh-CN', 'en-US'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const width of [672, 768]) it(`${locale} ${theme}: complete shortcut names in a ${width}px host`, async () => {
    await prepare(locale, theme, width === 672 ? 800 : 1280);
    if (width === 672) {
      render(theme, <ModalRenderer />);
      showModal('keyboardShortcutsModal', {});
    } else {
      render(theme, <Dialog open><DialogContent className="sm:max-w-[768px]"><KeyboardShortcutsCheatSheet onClose={() => undefined} onSuccess={() => undefined} /></DialogContent></Dialog>);
    }
    await until('real shortcut rows mounted', () => document.querySelectorAll('[data-slot="dialog-content"] div.cursor-pointer').length > 10);
    await settled();
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    await page.screenshot({ path: `__screenshots__/ui2851-shortcuts/overview-${locale}-${theme}-${width}.png` });
    expect(popup.getBoundingClientRect().width).toBe(width);
    const grid = popup.querySelector<HTMLElement>('.gg-shortcuts-grid')!;
    expect(grid, 'the explicit overview grid').not.toBeNull();
    expect(getComputedStyle(grid).gridTemplateAreas).not.toContain('tasks');
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth + 1);
    for (const row of popup.querySelectorAll<HTMLElement>('[data-shortcut-id]')) {
      const label = row.firstElementChild as HTMLElement;
      expect(label.getBoundingClientRect().width, label.textContent ?? 'label').toBeGreaterThan(40);
      expect(getComputedStyle(label).textOverflow).not.toBe('ellipsis');
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    }
    expect(popup.textContent).not.toMatch(/New Task|Task history|Task View|新建任务/);
    const search = popup.querySelector<HTMLInputElement>('input')!;
    await userEvent.fill(search, locale === 'zh-CN' ? '智能体' : 'agent');
    await until('localized search retains the agent creation command', () => !!popup.querySelector('[data-shortcut-id="app.newSession"]'));
    expect(popup.querySelector('[data-shortcut-id="app.newSession"]')?.textContent).toMatch(locale === 'zh-CN' ? /智能体/ : /agent/i);
  });

  for (const width of [800, 1280]) it(`${locale} ${theme}: settings use the localized command directory at ${width}px`, async () => {
    await prepare(locale, theme, width);
    host!.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--bg);color:var(--text-primary);padding:24px';
    render(theme, <KeyboardSettingsCard />);
    await until('real configurable commands mounted', () => !!host?.querySelector('[data-command-id="app.newSession"]'));
    await settled();
    await page.screenshot({ path: `__screenshots__/ui2851-shortcuts/settings-${locale}-${theme}-${width}.png` });
    const settings = host!.textContent!;
    expect(settings).not.toMatch(/New Task|Task history|新建任务/);
    if (locale === 'zh-CN') {
      expect(settings).not.toMatch(/Open Settings|Open application settings|NAVIGATION/);
      expect(host!.querySelector('[data-command-id="app.newSession"]')?.textContent).toContain('智能体');
      expect(settings).toContain('智能体视图');
    } else expect(host!.querySelector('[data-command-id="app.newSession"]')?.textContent).toMatch(/agent/i);
  });
}
