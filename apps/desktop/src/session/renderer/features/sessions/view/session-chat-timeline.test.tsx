// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionChatTimeline } from './session-chat-timeline';

vi.mock('@renderer/features/tabs/pane-context', () => ({ usePaneContext: () => ({ pane: { resolvedTabs: [] } }) }));
vi.mock('./session-timeline', () => ({ SessionTimeline: () => <i data-timeline="" />, useSessionTimelinePresence: () => false }));

it('reserves the lanes in a wide block before the task has turns, so the composer does not move when they arrive', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800 } as DOMRect);
  const host = document.createElement('div');
  act(() => createRoot(host).render(<SessionChatTimeline>body</SessionChatTimeline>));
  expect((host.firstElementChild as HTMLElement).className).toContain('px-6');
  expect(host.querySelector('[data-timeline]')).toBeNull();
});
