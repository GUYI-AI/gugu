import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped Files App on a session's working copy that is on another machine: its images are listed with their
// suffix, and none is read whole over that machine's link for a 16px picture.
const base = { workspace: 'session:far', type: 'binary', contentType: 'image/png', size: 3 * 1024 * 1024, parentId: null, systemRole: null, version: 1, createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [], keep: null, availability: 'available' };
const entries = [
  { ...base, id: 'shots/a.png', path: 'shots/a.png', name: 'a.png', displayName: 'a.png' },
  { ...base, id: 'shots/b.png', path: 'shots/b.png', name: 'b.png', displayName: 'b.png' },
];
const open = vi.fn(async () => { throw new Error('read over the link'); });
const style = document.createElement('style');

beforeAll(async () => {
  localStorage.clear();
  await page.viewport(800, 600);
  style.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(style);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu: {
    getContext: async () => ({ locale: 'en-US', themeMode: 'light', workspace: { id: 'session:far', deviceId: 'device-2', deviceLabel: 'build box' }, capabilities: ['files:read'] }),
    onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
    files: { viewPreferences: async () => ({ showAppData: false }), list: async () => entries, onChanged: () => () => {}, open, openWith: async () => {} },
  } });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error The preinstalled App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the real Files App lists both images', () => document.querySelectorAll('li.file[data-id]').length === 2);
});
afterAll(() => { style.remove(); });

it('reads no image of a working copy on another machine for its thumbnail', async () => {
  // Long enough for the rows on screen to have asked for their pictures, were they going to.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(open).not.toHaveBeenCalled();
  const marks = [...document.querySelectorAll('li.file[data-id] .file-mark')];
  expect(marks).toHaveLength(2);
  expect(marks.filter((mark) => mark.classList.contains('has-thumb'))).toEqual([]);
});
