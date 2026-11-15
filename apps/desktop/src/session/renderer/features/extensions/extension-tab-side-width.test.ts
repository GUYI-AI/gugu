import { describe, expect, it } from 'vitest';
import { SIDE_PAGE_WIDTH_PX } from '@renderer/features/tabs/side-width';
import { createExtensionTabProvider } from './extension-tab-provider';
import { installedExtensionsStore } from './installed-extensions-store';

// An App's page beside a task's conversation takes the same declared width as beside a chat (side-width.ts, owner 11-07).
describe('an App page declares its width beside a task conversation', () => {
  installedExtensionsStore.applyList({
    extensions: [{ id: 'kanban', name: 'Kanban', version: '1.0.0', apiVersion: 16, defaultLocale: 'en', contributes: { tabs: [{ name: 'board', title: 'Board', sideWidth: 480 }, { name: 'settings', title: 'Settings', hostPage: 'settings' }, { name: 'peer', title: 'Peer' }] } }],
    invalid: [],
  } as never);
  it('its own page: the manifest sideWidth; its host settings form: the side page width', () => {
    expect(createExtensionTabProvider('kanban', 'board').sideWidth?.({})).toBe(480);
    expect(createExtensionTabProvider('kanban', 'settings').sideWidth?.({})).toBe(SIDE_PAGE_WIDTH_PX);
  });
  it('undeclared, or a file opened in it: a peer, half each', () => {
    expect(createExtensionTabProvider('kanban', 'peer').sideWidth?.({})).toBeUndefined();
    expect(createExtensionTabProvider('kanban', 'board').sideWidth?.({ filePath: '/w/a.sql' })).toBeUndefined();
  });
});
