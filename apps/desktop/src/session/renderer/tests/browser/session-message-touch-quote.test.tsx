import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView, buildChatTheme, DEFAULT_CONFIG } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../features/sessions/acp/acp-chat-store';
import { useSessionMessageQuotes } from '../../features/sessions/acp/use-session-message-quotes';
import { finishRendererContentMenu, RENDERER_CONTENT_MENU_OPEN, RENDERER_MESSAGE_MENU_OPEN } from '@/lib/contentContextMenu';
import type { RendererContentContextMenu, RendererMessageMenu } from '@/lib/contentContextMenu';
import { FORWARD_PIECES_OPEN } from '@/components/chat/forwardToChats';
import { platform } from '@/platform';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText: vi.fn() } }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { vi.useRealTimers(); harness?.cleanup(); document.getSelection()?.removeAllRanges(); });

async function mountMessage() {
  const store = { sessionId: 'task-a', setDraftText: vi.fn(), chatState: { transcript: { state: { committedTurns: [] } } } } as unknown as AcpChatStore;
  function Harness() {
    const parent = useRef<HTMLDivElement>(null);
    const quotes = useSessionMessageQuotes(store, useRef(null), { phone: true });
    useEffect(() => {
      const context = createChatContext({ locale: () => 'en-US', theme: buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 48, agentConversation: true }) });
      const state = createChatState(context);
      state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'source', role: 'user', seq: 0, text: 'Original message words' }] }]);
      const view = createChatView({ context, state, parent: parent.current!, commands: { onMessageTextMount: quotes.onMessageTextMount } });
      return () => view.dispose();
    }, [quotes.onMessageTextMount]);
    return <div ref={parent} style={{ width: 390, height: 500 }} />;
  }
  harness = createReactHarness();
  await harness.render(<Harness />);
  await until('real conversation bubble is mounted', () => !!harness.container.querySelector('[data-user-card="source"]'));
  // A hold is cancelled by any scroll. The list settles its scroll position in the frame the bubble mounts, and the
  // browser reports that scroll on the next frame: a finger cannot land inside that frame, so the hold starts after it.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const bubble = harness.container.querySelector<HTMLElement>('[data-user-card="source"]')!;
  const text = bubble.querySelector<HTMLElement>('[data-conversation-text]')!;
  return { store, bubble, text };
}

function touch(target: HTMLElement, type: string, x = 20, y = 20) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
}

it('lifts the bubble into the chat\'s message menu from phone bubble padding: copy, quote and forward', async () => {
  const { store, bubble } = await mountMessage();
  const requests: RendererMessageMenu[] = [];
  const capture = (event: Event) => requests.push((event as CustomEvent<RendererMessageMenu>).detail);
  const forwards: unknown[] = [];
  const forward = (event: Event) => forwards.push((event as CustomEvent).detail);
  window.addEventListener(RENDERER_MESSAGE_MENU_OPEN, capture);
  window.addEventListener(FORWARD_PIECES_OPEN, forward);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(bubble, 'pointerdown');
    await vi.advanceTimersByTimeAsync(501);
    expect(requests).toHaveLength(1);
    const menu = requests[0];
    expect(menu.lift?.bubble).toBe(bubble);
    expect(menu.lift?.mine).toBe(true);
    expect(menu.onEditMessage).toBeUndefined();
    expect(menu.onForkTask).toBeUndefined();
    menu.onForward?.();
    expect(forwards).toEqual([[{ kind: 'text', sender: null, text: 'Original message words' }]]);
    menu.onQuoteToComposer?.();
    expect(store.setDraftText).toHaveBeenCalledWith('> Original message words\n\n');
  } finally {
    window.removeEventListener(RENDERER_MESSAGE_MENU_OPEN, capture);
    window.removeEventListener(FORWARD_PIECES_OPEN, forward);
  }
});

it('leaves native text selection alone and cancels a padding hold when scrolling or unmounting', async () => {
  const { bubble, text } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_MESSAGE_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(text, 'pointerdown');
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
    touch(text, 'pointerup');
    touch(bubble, 'pointerdown');
    touch(bubble, 'pointermove', 40, 20);
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
    touch(bubble, 'pointerdown');
    harness.cleanup();
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
  } finally { window.removeEventListener(RENDERER_MESSAGE_MENU_OPEN, capture); }
});

it.each(['before', 'after'] as const)('handles an Android context menu arriving %s the hold timer only once', async timing => {
  const { bubble } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_MESSAGE_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(bubble, 'pointerdown');
    if (timing === 'after') await vi.advanceTimersByTimeAsync(501);
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).toHaveBeenCalledOnce();
  } finally { window.removeEventListener(RENDERER_MESSAGE_MENU_OPEN, capture); }
});

it('offers copying for selected text on Android and keeps its handle adjustments', async () => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
  const { text } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(capture).toHaveBeenCalledOnce();
    const request = (capture.mock.calls[0][0] as CustomEvent<RendererContentContextMenu>).detail;
    expect(request.items.filter(item => 'id' in item).map(item => item.id)).toEqual(['copy']);
    expect(!!request.selectionRange).toBe(true);
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!;
    selection.setBaseAndExtent(node, 0, node, 8);
    finishRendererContentMenu(request.requestId, 'copy');
    await Promise.resolve();
    expect(platform.writeClipboardText).toHaveBeenLastCalledWith('Original');
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});

it('offers the selection menu for selected text on the phone web build', async () => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
  vi.mocked(platform.writeClipboardText).mockResolvedValue(undefined);
  const { text } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_MESSAGE_MENU_OPEN, capture);
  try {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(capture).toHaveBeenCalledOnce();
    const request = (capture.mock.calls[0][0] as CustomEvent<RendererMessageMenu>).detail;
    expect(request.hasSelection).toBe(true);
    request.onCopy?.();
    await Promise.resolve();
    expect(platform.writeClipboardText).toHaveBeenLastCalledWith('Original message words');
  } finally { window.removeEventListener(RENDERER_MESSAGE_MENU_OPEN, capture); }
});
