import { afterAll, beforeAll, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App's grid of a chat's pictures in a narrow pane: more rows than the pane holds must scroll, each row
// as tall as its square picture and name, not squeezed so the pictures run over the rows below.
const at = '2026-11-17T08:00:00Z';
const pictures = Array.from({ length: 60 }, (_, i) => {
  const name = `picture-${String(i + 1).padStart(2, '0')}.png`;
  return { id: name, name, displayName: name, suffix: '.png', contentType: 'image/png', type: 'binary', size: 4_000, parentId: null,
    path: name, systemRole: null, version: 1, createdAt: at, updatedAt: at, sourceMessageIds: [], canDelete: true };
});
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  await page.viewport(360, 600);
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'en-US', themeMode: 'light', chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {}, linkTo: async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`,
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => pictures, onChanged: () => () => {}, canDelete: async (files: unknown) => [files].flat().map(() => true) },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App lists the pictures', () => document.querySelectorAll('li.file').length > 0);
  document.querySelector<HTMLButtonElement>('#kinds [data-kind="media"]')!.click();
  // A section shows its first pictures and offers the rest: more than four rows of three is enough.
  await until('the pictures are a grid', () => document.querySelectorAll('li.file.cell').length >= 12);
});
afterAll(() => { style.remove(); });

it('keeps each grid row as tall as its pictures and scrolls the rest', () => {
  const cells = [...document.querySelectorAll<HTMLElement>('li.file.cell')];
  const tops = [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)))];
  expect(tops.length).toBeGreaterThan(3);
  for (const cell of cells) {
    const box = cell.getBoundingClientRect();
    expect(box.height, cell.dataset.id).toBeGreaterThanOrEqual(cell.querySelector('.file-open')!.getBoundingClientRect().height);
    const above = cells.filter((other) => other.getBoundingClientRect().top < box.top);
    for (const other of above) expect(box.top, cell.dataset.id).toBeGreaterThanOrEqual(other.getBoundingClientRect().bottom);
  }
  const list = document.getElementById('file-list')!;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
});
