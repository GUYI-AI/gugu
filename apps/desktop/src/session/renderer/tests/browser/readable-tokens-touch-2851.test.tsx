import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LocalizationProvider, setLocalePreference } from '@/i18n';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { FileAttachmentCard } from '@/components/chat/FileAttachmentCard';
import { ChatNotificationLevelControl } from '@/components/chat/ChatNotificationLevelControl';
import { Unknown } from '@/components/ui/Unknown';
import { VersionHistorySection } from '@renderer/features/extensions/panel/app-version-history';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMessagingCatalog';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@renderer/features/extensions/panel/app-store.css';
import '@renderer/features/extensions/panel/extensions-panel.css';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const previousTheme = document.documentElement.dataset.theme;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
});

function rgba(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value);
}
function over(fg: number[], bg: number[]) {
  return fg.slice(0, 3).map((value, index) => value * fg[3] + bg[index] * (1 - fg[3]));
}
function background(element: Element | null): number[] {
  if (!element) return [255, 255, 255];
  return over(rgba(getComputedStyle(element).backgroundColor), background(element.parentElement));
}
function contrast(element: Element) {
  const bg = background(element);
  const fg = over(rgba(getComputedStyle(element).color), bg);
  const luma = (color: number[]) => color.reduce((sum, value, index) => {
    const channel = value / 255;
    return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  return (Math.max(luma(bg), luma(fg)) + 0.05) / (Math.min(luma(bg), luma(fg)) + 0.05);
}
const noop = () => undefined;
for (const theme of ['light', 'dark'] as const) {
  it.each([360, 390, 1100])(`${theme} at %ipx: metadata remains readable and release notes are tappable`, async width => {
    await page.viewport(width, 844);
    document.documentElement.dataset.theme = theme;
    setLocalePreference('zh-CN');
    host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'position:fixed;inset:0;background:var(--bg);color:var(--text-primary)';
    root = createRoot(host);
    root.render(<LocalizationProvider><SessionLocalizationProvider><SessionUiTheme theme={theme}>
      <FileAttachmentCard file={{ fileName: '协作说明.md', sizeBytes: 2048, mimeType: 'text/markdown' }} onOpen={noop} />
      <ChatNotificationLevelControl value="important" busy={false} onSelect={noop} />
      <Unknown className="h-64 w-full" />
      <div className="mk"><VersionHistorySection
        extensionId="readable" installedVersion="1.1.0" offeredVersion="1.1.0" locale="zh-CN"
        state={{ status: 'ready', data: [{ version: '1.1.0', publishedAt: '2026-11-12T08:00:00Z', releaseNotes: '第一行\n\n第二行完整说明', apiVersion: 53, minAppVersion: '4.0.0', yanked: null, compat: null }] }}
        translate={translateSessionMessage} onOpenExternal={noop}
      /></div>
    </SessionUiTheme></SessionLocalizationProvider></LocalizationProvider>);
    await until('real components commit', () => !!host?.querySelector('.xp-history-note'));
    const placeholder = host.querySelector<HTMLElement>('[data-unknown]')!;
    await until('delayed placeholder is visible', () => Number(getComputedStyle(placeholder).opacity) === 1);
    expect(getComputedStyle(placeholder).animationDelay).toBe('0.15s');
    expect(placeholder.getBoundingClientRect().height).toBe(256);
    expect(rgba(getComputedStyle(placeholder).backgroundColor).slice(0, 3)).not.toEqual(background(placeholder.parentElement));
    for (const selector of ['.gg-file-row-detail', '[aria-pressed="true"]', '.xp-history-date', '.xp-history-action .xp-state']) {
      const element = host.querySelector(selector)!;
      expect(element, selector).not.toBeNull();
      expect(contrast(element), `${selector} contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
    const note = host.querySelector<HTMLButtonElement>('button.xp-history-note')!;
    const before = note.getBoundingClientRect();
    expect(before.width).toBeGreaterThan(0);
    if (width < 600) expect(before.height).toBeGreaterThanOrEqual(44);
    else expect(before.height).toBeLessThan(44);
    await userEvent.click(note);
    await until('the full release note opens', () => note.getAttribute('aria-expanded') === 'true' && !!host?.querySelector('.xp-history-body'));
    expect(host.querySelector('.xp-history-body')?.textContent).toContain('第二行完整说明');
    if (width < 600) {
      await userEvent.click(note);
      await until('the full release note closes', () => note.getAttribute('aria-expanded') === 'false' && !host?.querySelector('.xp-history-body'));
    }
  });
}
