// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A chat this account was taken out of while it was on screen: real navigation, screen layout, screen actions and removal facts.
vi.mock('@/lib/replica', async (load) => ({ ...(await load<object>()), replicaAccount: () => ({ id: 'owner' }) }));
import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { ensureScreenLayoutSync, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
import { publishChatRemoved } from '@/lib/chatRemovalBridge';

beforeAll(() => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  for (const view of ['home', 'session', 'chat', 'screen'] as const) appState.navigation.registerView(view);
  ensureScreenLayoutSync();
});

afterEach(() => {
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  appState.navigation.navigate('home');
});

describe('a chat removed while it is looked at', () => {
  it('goes home when nothing else is on screen, instead of staying on a block that is no longer drawn', () => {
    showOnScreen({ kind: 'chat', chatId: 'gone' });
    expect(appState.navigation.currentViewId).toBe('chat');

    publishChatRemoved('owner', 'gone');

    expect([...screenLayout.blocks.values()]).toEqual([]);
    // Left on 'chat' with this id, the chat would not be drawn again even once the account is back in it: navigation never changed.
    expect(appState.navigation.currentViewId).toBe('home');
  });

  it('follows the block left on screen', () => {
    showOnScreen({ kind: 'chat', chatId: 'kept' });
    showBesideOnScreen({ kind: 'chat', chatId: 'gone' });

    publishChatRemoved('owner', 'gone');

    expect([...screenLayout.blocks.values()]).toEqual([{ kind: 'chat', chatId: 'kept' }]);
    expect(appState.navigation.currentViewId).toBe('chat');
    expect((appState.navigation.viewParamsStore.chat as { chatId?: string }).chatId).toBe('kept');
  });
});
