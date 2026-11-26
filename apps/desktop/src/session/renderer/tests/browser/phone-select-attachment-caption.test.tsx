/**
 * owner 11-20: a file sent with words under it (an HTML file and a note) had no "Select text" on a phone long-press.
 * The words are the message's text: the phone selects them, never the file card. A file sent alone has no text to select.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { act, type ReactNode } from 'react';
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { platform } from '@/platform';
import type { NativeTextSelection } from '@/platform/nativeTextSelection';
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));
const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { MessageAlbumContext } = await import('@/components/chat/MessageAlbumContext');

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  harness?.cleanup();
});

const CAPTION = 'Harbor notes for the trip';
const file = (id: string, caption?: string) => message({ id, content_type: 'attachment', content: attachmentEnvelope(`${id}.html`, 1234, 'text/html', caption) });

async function longPress(row: MessageItem, wrap: (bubble: ReactNode) => ReactNode = bubble => bubble, on: (bubble: HTMLElement) => Element = bubble => bubble) {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.className = 'gugu-skin emlight';
  harness.container.style.cssText = 'position:fixed;left:0;top:200px;width:390px';
  await renderWithAppProviders(harness, wrap(<MessageBubble msg={row} isGroup compactMobile onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} />));
  const bubble = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!;
  const at = on(bubble).getBoundingClientRect();
  await act(async () => { bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.left + 4, clientY: at.top + at.height / 2 })); });
  await until('menu opens', () => !!document.querySelector('[data-testid="message-action-menu"]'));
  return bubble;
}

async function selectText(bubble: HTMLElement) {
  const item = document.querySelector<HTMLElement>('[data-testid="message-action-selectText"]');
  expect(item, 'a file with words under it offers Select text').not.toBeNull();
  await act(async () => { item!.click(); });
  await until('the words are selected', () => !!window.getSelection()?.toString());
  const selection = window.getSelection()!;
  const caption = bubble.querySelector('.gg-md')!;
  expect(caption.textContent).toBe(CAPTION);
  expect(caption.contains(selection.anchorNode) && caption.contains(selection.focusNode), 'the selection stays inside the words, never the file card').toBe(true);
  return selection.toString();
}

it('a file with words under it selects the words when the file card is pressed', async () => {
  const bubble = await longPress(file('notes', CAPTION), undefined, bubble => bubble.querySelector('.gg-file-row')!);
  expect(await selectText(bubble)).toBe('Harbor');
});

it('the phone shell\'s native selection page gets the words alone, not the file name', async () => {
  const open = vi.fn<NativeTextSelection['open']>(async () => undefined);
  platform.textSelection = { open, close: async () => {} };
  try {
    await longPress(file('notes', CAPTION), undefined, bubble => bubble.querySelector('.gg-file-row')!);
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="message-action-selectText"]')!.click(); });
    await until('the native page opens', () => open.mock.calls.length > 0);
    const [request] = open.mock.calls[0]!;
    expect(request.text).toBe(CAPTION);
    expect(request.text.slice(request.start, request.end)).toBe('Harbor');
  } finally {
    delete platform.textSelection;
  }
});

it('a file with words under it selects the pressed word', async () => {
  const bubble = await longPress(file('notes', CAPTION), undefined, bubble => {
    const words = bubble.querySelector('.gg-md')!;
    const text = document.createTreeWalker(words, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, CAPTION.indexOf('trip'));
    range.setEnd(text, CAPTION.indexOf('trip') + 2);
    return range as unknown as Element;
  });
  expect(await selectText(bubble)).toBe('trip');
});

it('several files sent with words select the words, which ride on the last file', async () => {
  const first = file('first');
  const last = file('last', CAPTION);
  const bubble = await longPress(first, bubble => <MessageAlbumContext.Provider value={new Map([[first.id, [first, last]]])}>{bubble}</MessageAlbumContext.Provider>);
  expect(await selectText(bubble)).toBe('Harbor');
});

it('a file sent alone has no text to select', async () => {
  await longPress(file('alone'));
  expect(document.querySelector('[data-testid="message-action-copy"]'), 'the menu is the real one').not.toBeNull();
  expect(document.querySelector('[data-testid="message-action-selectText"]')).toBeNull();
});
