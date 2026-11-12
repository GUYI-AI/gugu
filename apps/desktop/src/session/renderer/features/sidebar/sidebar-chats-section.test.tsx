// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the one list has no 「对话」 header (owner, 11-12): the slot the chat list is drawn into is all there is.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('the one list\'s conversations', () => {
  it('is the chat list\'s slot alone: no 「对话」 title, no total unread count, no buttons', async () => {
    await act(async () => root.render(<SidebarChatsSection />));
    expect(host.querySelector('[data-region="sidebar-chat-list"]')).not.toBeNull();
    expect(host.querySelector('[data-sidebar-chats-header]')).toBeNull();
    expect(host.textContent).toBe('');
    expect(host.querySelector('button')).toBeNull();
  });
});
