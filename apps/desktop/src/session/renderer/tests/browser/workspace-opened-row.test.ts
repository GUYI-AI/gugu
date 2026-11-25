import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App and its styles. An image opens in the host's viewer, which covers the page and takes the
// pointer: the row it was opened from keeps the selected fill under the viewer and after it closes, instead of a
// hover fill that fades out under the opening picture and only comes back when the pointer moves.
const base = { chat: 'group', type: 'binary', contentType: 'image/png', size: 1000, parentId: null, path: '', systemRole: null, version: 1, createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [], keep: null, availability: 'available' };
const entries = [
  { ...base, id: 'one', name: 'photo-1.png', displayName: 'photo-1.png', updatedAt: new Date().toISOString() },
  { ...base, id: 'two', name: 'photo-2.png', displayName: 'photo-2.png' },
];
const openWith = vi.fn(async () => {});
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  await page.viewport(800, 600);
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'zh-CN', themeMode: 'light', chat: { id: 'group', name: 'group', kind: 'group', groupId: 'group' }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
    linkTo: async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`,
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => entries, onChanged: () => () => {}, openWith },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App draws both images', () => document.querySelectorAll('li.file[data-id]').length === 2);
});
afterAll(() => { style.remove(); });

const row = (id: string) => document.querySelector<HTMLElement>(`li.file[data-id="${id}"]`)!;
const fill = (el: Element) => getComputedStyle(el).backgroundColor;
/** The palette's selected fill, as the browser resolves it. */
function selectedFill() {
  const probe = document.createElement('div');
  probe.style.background = 'var(--em-selected)';
  document.body.append(probe);
  const value = fill(probe);
  probe.remove();
  return value;
}
/** What the host's image viewer does to the page under it: covers it and takes the pointer. */
function viewer() {
  const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;inset:0;z-index:10';
  document.body.append(cover);
  return cover;
}

it('the row an image was opened from keeps the selected fill under the viewer and after it closes', async () => {
  const selected = selectedFill();
  await page.elementLocator(row('one').querySelector('.file-open')!).click();
  expect(openWith).toHaveBeenCalledTimes(1);
  const resting = getComputedStyle(row('one'));
  expect(row('one').matches(':hover')).toBe(true);
  await untilStable('the press has settled', () => resting.backgroundColor);
  expect([resting.backgroundColor, resting.backgroundImage], 'the pointer resting on it draws nothing over the selected fill').toEqual([selected, 'none']);

  const cover = viewer();
  await userEvent.hover(cover);
  await until('the viewer has the pointer', () => !row('one').matches(':hover'));
  await untilStable('the row has settled under the viewer', () => fill(row('one')));
  expect(fill(row('one')), 'under the viewer: the selected fill, not a hover fill faded to nothing').toBe(selected);

  cover.remove();
  const elsewhere = Object.assign(document.createElement('div'), { style: 'position:fixed;right:0;bottom:0;width:8px;height:8px' });
  document.body.append(elsewhere);
  await userEvent.hover(elsewhere);
  await untilStable('the row has settled after the viewer', () => fill(row('one')));
  expect(fill(row('one')), 'after the viewer, pointer elsewhere').toBe(selected);
  expect(fill(row('two'))).toBe('rgba(0, 0, 0, 0)');
  expect(row('one').getAttribute('aria-current')).toBe('true');
  elsewhere.remove();

  // The next image opened takes the mark; one row carries it at a time.
  await page.elementLocator(row('two').querySelector('.file-open')!).click();
  expect(row('two').getAttribute('aria-current')).toBe('true');
  expect(row('one').hasAttribute('aria-current')).toBe(false);
});

it('shows which image is opening until its own host request finishes', async () => {
  const first = Promise.withResolvers<void>();
  const next = Promise.withResolvers<void>();
  openWith.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => next.promise);
  const click = (id: string) => page.elementLocator(row(id).querySelector('.file-open')!).click();
  // One thing at the row's end: a row with a time says it there in the time's place, one without wears it over its end.
  const drawn = (el: Element | null) => getComputedStyle(el!, '::after').content;
  const time = (id: string) => row(id).querySelector('.file-cell[data-cell="when"]');
  await click('one');
  expect(row('one').getAttribute('aria-busy')).toBe('true');
  expect(drawn(time('one'))).toBe('"正在打开…"');
  const clock = document.createRange();
  clock.selectNodeContents(time('one')!);
  expect(clock.getBoundingClientRect().width).toBe(0);
  expect(drawn(row('one'))).toBe('none');
  await click('two');
  first.resolve();
  expect(row('one').hasAttribute('aria-busy')).toBe(false);
  expect(drawn(time('one'))).toBe('none');
  expect(row('two').getAttribute('aria-busy')).toBe('true');
  expect(time('two')).toBeNull();
  expect(drawn(row('two'))).toBe('"正在打开…"');
  next.resolve();
  await until('opening is complete', () => !row('two').hasAttribute('aria-busy'));
});
