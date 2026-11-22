// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearViewState } from '../../../../apps/desktop/src/lib/viewStateTable';
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica';
import { createReactHarness } from '../../../support/testHarness';

vi.mock('@/platform', () => ({ platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } } }));
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, marketOffers: async () => ({ success: true, data: [] }), onMarketChanged: () => () => {}, groupFileOpener: vi.fn(), setOpenWithDefault: vi.fn() },
}));
vi.mock('@/components/extensionBundle/sharedPackages', async (original) => ({
  ...(await original<object>()), chatPackageCards: async () => (await import('./chatTabsHarness')).sharedCards.answer() }));
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn(async () => ({ error: null })) } }));
vi.mock('@/lib/fileAccess', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/fileAccess')>(),
  fileMetadata: vi.fn(async () => ({ status: 'gone', sha256: null })),
}));
const { ask, chatTabs, shownItem } = await import('./chatTabsHarness');
const { installedExtensions } = await import('@/session/renderer/features/extensions/installed-extensions');
const { GroupFileName } = await import('@/components/markdown/GroupFileName');
const { OpenWithPick } = await import('@/components/appSlot/OpenWithPick');
const workspace = { id: 'workspace', name: 'Folder', version: '1.0.0', apiVersion: 3, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Folder', opensFiles: { chat: ['.md', '.json'] } }] } };
const vote = { ...workspace, id: 'vote', contributes: { tabs: [{ name: 'main', title: 'Vote', opensFiles: { chat: ['.vote.json'] } }] } };
const candidate = { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: 'Folder', app: { name: 'Folder', defaultLocale: 'en' }, onlyTab: true, state: false, suffix: '.md' };
let harness: ReturnType<typeof createReactHarness>;
const originalCheckVisibility = HTMLElement.prototype.checkVisibility;
beforeEach(() => {
  // Signed in, as the harness's person (user-1): the group's shared packages are read for an account.
  followRendererSession('SIGNED_IN', 'user-1');
  harness = createReactHarness();
  HTMLElement.prototype.checkVisibility = () => false;
  act(() => installedExtensions.set(['local'], { extensions: [workspace, vote], invalid: [] } as never));
});
// Where each resource last opened is the account's (tab-placement memory): each case starts with none remembered (after
// the setup above, whose closing of tabs is itself remembered).
beforeEach(() => { clearViewState({ conversation: '', panel: 'tab-placement' }) });
afterEach(() => {
  harness.cleanup();
  HTMLElement.prototype.checkVisibility = originalCheckVisibility;
  act(() => installedExtensions.set(['local'], { extensions: [], invalid: [] } as never));
});

describe('stored file names on message, tab, and chooser surfaces', () => {
  it.each([
    ['群公告.md', '群公告.md'], ['group-meta.json', 'group-meta.json'],
    ['todo.txt', 'todo.txt'], ['banner.png', 'banner.png'], ['x.vote.json', 'x'],
  ])('message file %s reads %s', async (name, expected) => {
    await harness.render(createElement(GroupFileName, { name }));
    expect(harness.container.textContent).toBe(expected);
  });

  it.each(['md', 'json'])('a claimed .%s file keeps its complete tab title', async suffix => {
    const chatId = `names-${suffix}`;
    const name = `report.${suffix}`;
    await harness.render(chatTabs({ chatId }));
    await act(async () => ask(chatId, { itemId: `file-${suffix}`, opener: {
      chatId, itemId: `file-${suffix}`, name, typedName: name,
      file: { document: false, contentType: suffix === 'md' ? 'text/markdown' : 'application/json', version: 1, size: 10 },
      choice: { kind: 'one', candidate: { ...candidate, suffix: `.${suffix}` } },
    } as never }));
    expect(shownItem(chatId)).toMatchObject({ kind: 'workspace.main', title: name });
  });

  it('the chooser heading keeps the generic file suffix', async () => {
    await harness.render(createElement(OpenWithPick, { detail: {
      chatId: 'names-chooser', itemId: 'file-md', name: 'report.md', typedName: 'report.md',
      file: { document: false, contentType: 'text/markdown', version: 1, size: 10 },
      choice: { kind: 'choose', suffix: '.md', candidates: [candidate] },
    }, onPick: vi.fn() }));
    expect(harness.container.querySelector('[data-testid="group-app-open-with"]')?.textContent).toContain('report.md');
  });
});

it('the shared-package mock is live (signed in): a file waits for this chat\'s packages, then is drawn', async () => {
  const { expectSharedPackagesLive } = await import('./chatTabsHarness');
  await expectSharedPackagesLive((node) => harness.render(node));
});
