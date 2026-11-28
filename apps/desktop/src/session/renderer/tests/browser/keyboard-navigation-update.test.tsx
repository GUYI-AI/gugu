import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from '@vitest/browser/context';
import { afterEach, expect, it, vi } from 'vitest';
import { AppKeyboardShortcuts } from '@renderer/lib/components/app-keyboard-shortcuts';
import { KeyboardDispatcher } from '@renderer/lib/commands/keyboard-dispatcher';
import { takeKeyboardUpdateNotice } from '@renderer/lib/components/keyboard-update-notice';
import { readInterface, writeInterface } from '@/lib/viewStateTable';
import { COMMANDS } from '@shared/commands';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { useAppSettingsKey: () => fakeAppSettings({}) };
});
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ exitZenMode: () => {} }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useWorkspaceSlots: () => ({ currentView: 'home' }), useParams: () => ({ params: {} }),
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));

const account = 'keyboard-update-test';
afterEach(() => writeInterface('keyboard-defaults-update', undefined, account));

it('waits for saved settings and informs a returning default-key user only once', () => {
  expect(takeKeyboardUpdateNotice(account, account, null)).toBe(false);
  expect(readInterface('keyboard-defaults-update', account)).toBeUndefined();
  expect(takeKeyboardUpdateNotice(account, account, {})).toBe(true);
  expect(takeKeyboardUpdateNotice(account, account, {})).toBe(false);
});

it('keeps first use quiet, including after restart with the same signed-in account', () => {
  expect(takeKeyboardUpdateNotice(account, null, null)).toBe(false);
  expect(takeKeyboardUpdateNotice(account, account, {})).toBe(false);
});

it('keeps an unaffected returning user quiet when the former defaults were cleared', () => {
  const cleared = Object.fromEntries(Object.keys(COMMANDS).map(id => [id, null]));
  expect(takeKeyboardUpdateNotice(account, account, cleared)).toBe(false);
});

it('walks the sidebar, content and editor forward and backward, skipping a hidden sidebar', async () => {
  const app = document.body.appendChild(document.createElement('div'));
  const root = createRoot(app);
  const workspace = document.body.appendChild(document.createElement('div'));
  workspace.innerHTML = '<aside data-region="left-sidebar"><button data-nav-cursor>Conversation</button></aside>' +
    '<section data-workspace-content-surface tabindex="-1"><textarea data-testid="chat-composer"></textarea></section>';
  const sidebar = workspace.querySelector('button')!;
  const block = workspace.querySelector('section')!;
  const editor = workspace.querySelector('textarea')!;
  try {
    await act(async () => root.render(<><KeyboardDispatcher /><AppKeyboardShortcuts /></>));
    sidebar.focus();
    for (const [key, target] of [
      ['{F6}', block], ['{F6}', editor], ['{F6}', sidebar], ['{Shift>}{F6}{/Shift}', editor],
      ['{Shift>}{F6}{/Shift}', block], ['{Shift>}{F6}{/Shift}', sidebar],
    ] as const) {
      await userEvent.keyboard(key);
      expect(document.activeElement).toBe(target);
    }
    workspace.querySelector('aside')!.hidden = true;
    editor.focus();
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(block);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(editor);
  } finally {
    await act(async () => root.unmount());
    app.remove();
    workspace.remove();
  }
});
