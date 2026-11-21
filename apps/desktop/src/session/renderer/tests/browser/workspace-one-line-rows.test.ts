import { afterAll, beforeAll, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App on a chat's folder, with a mouse: one line per entry — its mark, its name, one value at its end
// (a folder's count, a file's time); from 560px wide, Size and Modified as columns under the head.
const at = new Date(Date.now() - 3600_000).toISOString();
const base = { chat: 'group', parentId: null, path: '', systemRole: null, version: 1, createdAt: at, updatedAt: at, createdBy: null, sourceMessageIds: [], keep: null, availability: 'available' };
const entries = [
  { ...base, id: 'one', name: 'One thing', displayName: 'One thing', type: 'folder', childCount: 1 },
  { ...base, id: 'two', name: 'Two things', displayName: 'Two things', type: 'folder', childCount: 2 },
  { ...base, id: 'pdf', name: 'a-report-with-a-name-long-enough-to-run-past-the-pane-on-any-phone-or-sidebar.pdf', displayName: 'a-report-with-a-name-long-enough-to-run-past-the-pane-on-any-phone-or-sidebar.pdf', type: 'binary', contentType: 'application/pdf', size: 2_400_000 },
  { ...base, id: 'md', name: 'notes.md', displayName: 'notes.md', type: 'text', contentType: 'text/markdown', size: 3000 },
];
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'en-US', themeMode: 'light', chat: { id: 'group', name: 'group', kind: 'group', groupId: 'group' }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
    linkTo: async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`,
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => entries, onChanged: () => () => {} },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App draws every entry', () => document.querySelectorAll('li.file[data-id]').length === entries.length);
});
afterAll(() => { style.remove(); });

const row = (id: string) => document.querySelector<HTMLElement>(`li.file[data-id="${id}"]`)!;
const box = (el: Element | null) => el!.getBoundingClientRect();
const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none';

it.each([360, 420])('at %ipx every entry is one line: mark, name, and one value at its end', async (width) => {
  await page.viewport(width, 700);
  await until('the pane has its width', () => document.documentElement.clientWidth === width);
  expect(shown(document.querySelector('.table-head'))).toBe(false);
  for (const id of entries.map((e) => e.id)) {
    const li = row(id);
    const name = box(li.querySelector('.file-name'));
    const meta = box(li.querySelector('.file-meta'));
    expect(box(li).height, id).toBeLessThanOrEqual(32);
    expect(box(li.querySelector('.file-mark')).width, id).toBe(16);
    // The value sits on the name's line, at the row's end.
    expect(Math.abs(name.top + name.height / 2 - (meta.top + meta.height / 2)), id).toBeLessThanOrEqual(2);
    expect(box(li).right - meta.right, id).toBeLessThanOrEqual(12);
    expect(name.right, id).toBeLessThanOrEqual(meta.left);
  }
  expect(row('one').querySelector('.file-meta')!.textContent).toBe('1 item');
  expect(row('two').querySelector('.file-meta')!.textContent).toBe('2 items');
  // A file's size waits for its column; its time is its one value.
  expect(shown(row('pdf').querySelector('[data-cell="size"]'))).toBe(false);
  expect(shown(row('pdf').querySelector('[data-cell="when"]'))).toBe(true);
});

it('at 640px Size and Modified are columns under the head, in the same one-line row', async () => {
  await page.viewport(640, 700);
  await until('the head is drawn', () => shown(document.querySelector('.table-head')));
  const head = document.querySelector('.table-head')!;
  // Name starts where the names do; its label is text, not a centred button.
  const label = document.createRange(); label.selectNodeContents(head.querySelector('[data-cell="name"]')!);
  expect(Math.abs(label.getBoundingClientRect().left - box(row('md').querySelector('.file-name')).left)).toBeLessThanOrEqual(1);
  for (const cell of ['size', 'when']) {
    const column = box(head.querySelector(`[data-cell="${cell}"]`));
    for (const id of ['pdf', 'md']) {
      const value = row(id).querySelector(`.file-cell[data-cell="${cell}"]`);
      expect(shown(value), `${id} ${cell}`).toBe(true);
      expect(Math.abs(box(value).right - column.right), `${id} ${cell} lines up with its head`).toBeLessThanOrEqual(1);
    }
  }
  // A folder's count stands in the Size column.
  expect(Math.abs(box(row('two').querySelector('[data-cell="size"]')).right - box(head.querySelector('[data-cell="size"]')).right)).toBeLessThanOrEqual(1);
  for (const id of entries.map((e) => e.id)) expect(box(row(id)).height, id).toBeLessThanOrEqual(32);
});

it('the phone keeps its two-line rows, in the list\'s language: a 24px muted mark, the name at 400, the value under it', async () => {
  // The coarse-pointer block, switched on as the phone tests do (this browser has a mouse).
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss.replaceAll('@media (hover: none) and (pointer: coarse)', '@media all');
  await page.viewport(390, 700);
  await until('the phone rows are drawn', () => box(row('md').querySelector('.file-mark')).width === 24);
  for (const id of ['pdf', 'md']) {
    const li = row(id);
    expect(getComputedStyle(li.querySelector('.file-name')!).fontWeight, id).toBe('400');
    expect(box(li.querySelector('.file-meta')).top, id).toBeGreaterThanOrEqual(box(li.querySelector('.file-name')).bottom - 1);
  }
});
