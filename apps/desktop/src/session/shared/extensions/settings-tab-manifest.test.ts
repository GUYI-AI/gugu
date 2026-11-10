import { describe, expect, it } from 'vitest';
import { safeParseExtensionManifest } from './manifest';

const app = (settingsTab: string, tabs: object[], apiVersion = 35) => ({ id: 'search', name: 'Search', version: '1.0.0', apiVersion, defaultLocale: 'en', entry: 'index.html', contributes: { tabs, settingsTab } });
const page = { name: 'main', title: 'Search' };
const own = { name: 'keys', title: 'Keys', entry: 'keys.html' };

describe('contributes.settingsTab', () => {
  it('names a page of its own', () => {
    expect(safeParseExtensionManifest(app('keys', [page, own])).ok).toBe(true);
  });
  it('needs API 35', () => {
    expect(safeParseExtensionManifest(app('keys', [page, own], 34)).ok).toBe(false);
  });
  it.each([
    ['a tab it does not have', 'gone', [page]],
    ['a host page', 'set', [page, { name: 'set', title: 'Set', hostPage: 'settings' }]],
    ['a card, even its only tab', 'card', [{ name: 'card', title: 'Card', widget: { height: 120 } }]],
    ['a file opener', 'file', [page, { name: 'file', title: 'File', opensFiles: { chat: ['.x'] } }]],
    ['a per-task page', 'each', [page, { name: 'each', title: 'Each', perSession: true }]],
  ])('refuses %s', (_what, tab, tabs) => {
    expect(safeParseExtensionManifest(app(tab as string, tabs as object[])).ok).toBe(false);
  });
});
