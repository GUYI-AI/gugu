// @vitest-environment jsdom
// The sidebar opens a fresh global search even while viewing a group.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInAction } from 'mobx';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({ useShortcutOverrides: () => null, getEffectiveHotkey: () => null }));

const { commandRegistry } = await import('@renderer/lib/commands/registry');
const { updateSearchSession, useSearchSession } = await import('@renderer/features/global-search/search-session');
const { innerSidebarChat } = await import('./inner-sidebar-anchor');
const { SidebarSearchTrigger } = await import('./sidebar-search-trigger');

let host: HTMLDivElement;
let root: Root;
let chips: unknown;
function SessionProbe() {
  chips = useSearchSession().chips;
  return null;
}
let unregister: () => void;
beforeEach(async () => {
  unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: () => {} }] });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => root.render(<><SidebarSearchTrigger /><SessionProbe /></>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  unregister();
  runInAction(() => innerSidebarChat.set(null));
});
const click = () => act(async () => host.querySelector<HTMLElement>('[data-testid="sidebar-search-trigger"]')!.click());

it('with a group open, clears the last search scope and opens globally', async () => {
  runInAction(() => innerSidebarChat.set({ kind: 'group', chatId: 'grp-1' }));
  await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: 'prior-group' }] }));
  await click();
  expect(chips).toEqual([]);
});

it('a project, or no group, opens it unscoped', async () => {
  runInAction(() => innerSidebarChat.set({ kind: 'project', chatId: 'project-chat' }));
  await click();
  expect(chips).toEqual([]);
  runInAction(() => innerSidebarChat.set(null));
  await click();
  expect(chips).toEqual([]);
});
