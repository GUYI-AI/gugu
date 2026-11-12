// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the one list keeps the 「对话」 header over its conversations: a title with today's red unread count,
// nothing to fold it with (the list is always open) and no 「+」 (the one list's top has it).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, params?: { count?: number }) => (params?.count === undefined ? key : `${key}:${params.count}`) }),
}));
vi.mock('@/lib/shellSlots', () => ({ readShellSlots: () => null }));

const { SidebarChatsSection } = await import('./sidebar-chats-section');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the one list\'s 「对话」 header', () => {
  it('is the title and the unread count, with no fold toggle and no 「+」; the list is always open', async () => {
    await act(async () => root.render(<SidebarChatsSection unread={9} />));
    const header = host.querySelector<HTMLElement>('[data-sidebar-chats-header]')!;
    expect(header.textContent).toBe('sidebar.chats9');
    expect(header.querySelector('[aria-label="sidebar.unreadCount:9"]')!.textContent).toBe('9');
    expect(header.querySelector('button')).toBeNull();
    expect(host.querySelector('[data-region="sidebar-chat-list"]')).not.toBeNull();
  });

  it('shows no number when nothing is unread', async () => {
    await act(async () => root.render(<SidebarChatsSection unread={0} />));
    expect(host.querySelector('[data-sidebar-chats-header]')!.textContent).toBe('sidebar.chats');
  });
});
