import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App and its styles. Only the pending service availability response is mocked.
const base = { chat: 'group', type: 'binary', contentType: 'application/pdf', size: 1000, parentId: null, path: '', systemRole: null, version: 1, createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [], keep: null };
const entries = [
  { ...base, id: 'readable', name: '可读文件.pdf', displayName: '可读文件.pdf', availability: 'available' },
  { ...base, id: 'expired', name: '旧图片.png', displayName: '旧图片.png', contentType: 'image/png', availability: 'expired' },
  { ...base, id: 'deleted', name: '旧报告.pdf', displayName: '旧报告.pdf', availability: 'deleted' },
];
const openWith = vi.fn(async () => {});
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  await page.viewport(1000, 760);
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'zh-CN', themeMode: 'light', chat: { id: 'group', name: '测试群', kind: 'group', groupId: 'group' }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
    linkTo: async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`,
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => entries, onChanged: () => () => {}, openWith },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App draws the service response', () => !!document.querySelector('[data-block="expired"] .section-toggle'));
  await page.elementLocator(document.querySelector('[data-block="expired"] .section-toggle')!).click();
});
afterAll(() => { style.remove(); });

it.each([1000, 390])('shows availability and a short opening explanation at %ipx', async width => {
  await page.viewport(width, 760);
  const readable = document.querySelector<HTMLElement>('[data-id="readable"]')!;
  const opacity = Number(getComputedStyle(readable).opacity);
  for (const id of ['expired', 'deleted']) {
    const row = document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    expect(Number(getComputedStyle(row).opacity)).toBeLessThan(opacity);
    expect(row.querySelector('.file-keep')?.textContent).toBe('已过期');
    expect(row.textContent).not.toContain('·');
    expect(row.querySelector('.file-open')?.getAttribute('title')).not.toContain('·');
    openWith.mockClear();
    await page.elementLocator(row.querySelector('.file-open')!).click();
    const banner = document.getElementById('list-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('云端已删除，可以让上传的人重新发');
    expect(openWith).not.toHaveBeenCalled();
  }
  await page.screenshot({ path: `__screenshots__/file-availability-${width}.png` });
});
