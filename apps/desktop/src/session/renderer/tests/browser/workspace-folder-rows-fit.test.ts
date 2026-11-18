import { afterAll, beforeAll, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App on a computer's folder: its folders come without a count, so each row is one line. More of them
// than the pane holds must scroll, not squeeze every row under its own line (the list is a flex column).
const folders = Array.from({ length: 60 }, (_, i) => {
  const name = `folder-${String(i + 1).padStart(2, '0')}`;
  return { id: name, name, displayName: name, type: 'folder', workspace: 'copy', parentId: null, updatedAt: null };
});
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  await page.viewport(360, 600);
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'en-US', themeMode: 'light', workspace: { id: 'copy', root: '/work', thisMachine: true }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => folders, onChanged: () => () => {} },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App draws the folders', () => document.querySelectorAll('.file[data-folder]').length === folders.length);
});
afterAll(() => { style.remove(); });

it('keeps each count-less folder row a whole line and scrolls the rest', () => {
  const rows = [...document.querySelectorAll<HTMLElement>('.file[data-folder]')];
  expect(rows[0].querySelector('.file-cell')).toBeNull();
  for (const [i, row] of rows.entries()) {
    const button = row.querySelector('.file-open')!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    expect(box.height, row.dataset.id).toBeGreaterThanOrEqual(button.height);
    if (i) expect(box.top, row.dataset.id).toBeGreaterThanOrEqual(rows[i - 1].getBoundingClientRect().bottom);
  }
  const list = document.getElementById('file-list')!;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
});
