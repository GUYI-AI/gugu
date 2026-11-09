// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { messageQuoteText } from '@gugu/core/shared/ui/messageQuote';
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels';
import { createReactHarness } from '../../../support/testHarness';

const menu = vi.hoisted(() => vi.fn());
const messageMenu = vi.hoisted(() => vi.fn());
const writeClipboardText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/contentContextMenu', () => ({ showRendererContentMenu: menu, showRendererMessageMenu: messageMenu }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
const { useSessionMessageQuotes } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-message-quotes');

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); menu.mockReset(); messageMenu.mockReset(); writeClipboardText.mockClear(); toast.mockClear(); document.getSelection()?.removeAllRanges(); });
afterEach(() => harness.cleanup());

const rightClick = (root: Element) => act(async () => { root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
const asked = () => messageMenu.mock.calls.at(-1)![0];

async function setup(actions: Parameters<typeof useSessionMessageQuotes>[2] | null = {}) {
  const state = { sessionId: 'session-a', draftText: 'my question', submitPrompt: vi.fn(), queuePrompt: vi.fn(), setDraftText(text: string) { this.draftText = text; } };
  const store = state as unknown as AcpChatStore;
  const editor = { current: { setText: vi.fn(), focus: vi.fn(), getText: () => state.draftText } as unknown as PromptEditorRef };
  let commands!: ReturnType<typeof useSessionMessageQuotes>;
  function Probe({ current = store }: { current?: AcpChatStore }) { commands = useSessionMessageQuotes(current, editor, actions ?? undefined); return null; }
  await harness.render(createElement(Probe));
  const root = document.createElement('div'); root.textContent = 'same words'; document.body.append(root);
  let item: ChatMessage = { kind: 'message', id: 'first', role: 'assistant', text: 'same words' };
  const dispose = commands.onMessageTextMount({ root, itemId: item.id, message: () => item, sender: () => 'Agent' });
  return { state, editor, root, dispose, commands, setItem: (value: ChatMessage) => { item = value; }, render: (current: AcpChatStore) => harness.render(createElement(Probe, { current })) };
}

describe('task message copy menus and legacy prompt restoration', () => {
  it.each([false, true])('uses the platform clipboard for copy (selected=%s)', async selected => {
    const c = await setup();
    if (selected) {
      const range = document.createRange(); range.setStart(c.root.firstChild!, 0); range.setEnd(c.root.firstChild!, 4);
      document.getSelection()!.addRange(range);
    }
    await rightClick(c.root);
    expect(asked().hasSelection).toBe(selected);
    await act(async () => asked().onCopy());
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(selected ? 'same' : 'same words');
    expect(c.state.draftText).toBe('my question');
    c.dispose(); c.root.remove();
  });
  it('reports clipboard failure without a copied-success notification', async () => {
    const c = await setup();
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await rightClick(c.root);
    await act(async () => asked().onCopy());
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('same words');
    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: 'task.copyFailed', tier: 'error' });
    c.dispose(); c.root.remove();
  });
  it('quotes the whole message, or the selection, into the composer as markdown, and sends nothing', async () => {
    const c = await setup();
    c.state.draftText = '';
    await rightClick(c.root);
    await act(async () => asked().onQuoteToComposer());
    expect(c.editor.current.setText).toHaveBeenLastCalledWith('> same words\n\n');
    expect(c.state.draftText).toBe('> same words\n\n');
    const range = document.createRange(); range.setStart(c.root.firstChild!, 0); range.setEnd(c.root.firstChild!, 4);
    document.getSelection()!.addRange(range);
    await rightClick(c.root);
    await act(async () => asked().onQuoteToComposer());
    expect(c.editor.current.setText).toHaveBeenLastCalledWith('> same words\n\n> same\n\n');
    expect(c.state.submitPrompt).not.toHaveBeenCalled();
    expect(c.state.queuePrompt).not.toHaveBeenCalled();
    c.dispose(); c.root.remove();
  });
  it('takes the selection from before the right press, not the word the press itself selects', async () => {
    const c = await setup();
    c.root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
    const word = document.createRange(); word.setStart(c.root.firstChild!, 0); word.setEnd(c.root.firstChild!, 4);
    document.getSelection()!.addRange(word);
    await rightClick(c.root);
    expect(asked().hasSelection).toBe(false);
    expect(asked().content).toBe('same words');
    expect(document.getSelection()!.isCollapsed).toBe(true);
    c.dispose(); c.root.remove();
  });
  it('opens on a link, whose open action is the link\'s own click, as a left click would', async () => {
    const c = await setup();
    const link = document.createElement('a'); link.setAttribute('href', 'src/a.ts'); link.textContent = 'a'; c.root.append(link);
    const opened = vi.fn((event: Event) => event.preventDefault()); link.addEventListener('click', opened);
    await rightClick(link);
    await act(async () => asked().onCopyLink());
    // What the link says, not the page's absolute form of it.
    expect(writeClipboardText).toHaveBeenLastCalledWith('src/a.ts');
    await act(async () => asked().onOpenLink());
    expect(opened).toHaveBeenCalledOnce();
    c.dispose(); c.root.remove();
  });
  it('offers no open on a file its card says is gone', async () => {
    const c = await setup();
    const slot = document.createElement('div'); slot.dataset.sentMessageBody = 'sent'; slot.dataset.attachmentUnavailable = ''; c.root.append(slot);
    const inner = document.createElement('div'); inner.setAttribute('data-attachment-unavailable', ''); slot.append(inner);
    c.setItem({ kind: 'message', id: 'first', role: 'assistant', text: 'a.png', sentMessages: [{ id: 'sent', content_type: 'attachment', content: attachmentEnvelope('a.png', 1, 'image/png'), file_blob_id: 'blob' }] } as unknown as ChatMessage);
    await rightClick(inner);
    expect(asked().onOpenFile).toBeUndefined();
    c.dispose(); c.root.remove();
  });
  it('offers edit only on a message the store can edit, a person\'s own, and fork when the task can fork', async () => {
    const canEdit = vi.fn(() => true), onEdit = vi.fn(), onForkTask = vi.fn();
    const c = await setup({ canEdit, onEdit, onForkTask });
    await rightClick(c.root);
    expect(asked().onEditMessage).toBeUndefined();
    await act(async () => asked().onForkTask());
    expect(onForkTask).toHaveBeenCalledOnce();
    c.setItem({ kind: 'message', id: 'first', role: 'user', text: 'same words' });
    await rightClick(c.root);
    await act(async () => asked().onEditMessage());
    expect(onEdit).toHaveBeenCalledWith('first');
    canEdit.mockReturnValue(false);
    await rightClick(c.root);
    expect(asked().onEditMessage).toBeUndefined();
    c.dispose(); c.root.remove();
  });
  it('does nothing when a menu action arrives after the store changed', async () => {
    const c = await setup();
    await rightClick(c.root);
    const quote = asked().onQuoteToComposer;
    await c.render({ ...c.state, sessionId: 'session-b' } as unknown as AcpChatStore);
    await act(async () => quote());
    expect(c.editor.current.setText).not.toHaveBeenCalled();
    c.dispose(); c.root.remove();
  });
  it('restores only the body of a persisted quote without recreating its quote', async () => {
    const c = await setup();
    c.commands.restorePrompt({ text: messageQuoteText({ kind: 'session', sessionId: 'session-a', itemId: 'first' }, 'same words', 'Agent') + 'retry this' });
    expect(c.state.draftText).toBe('retry this');
    expect(c.editor.current.setText).toHaveBeenCalledWith('retry this');
    c.dispose(); c.root.remove();
  });
  it('keeps the copy menu, and nothing on a link, where the host gives no message actions (the phone)', async () => {
    const c = await setup(null);
    menu.mockResolvedValue('copy');
    await rightClick(c.root);
    expect(messageMenu).not.toHaveBeenCalled();
    expect(menu.mock.calls[0]![0]).toEqual([{ id: 'copy', label: 'transcript.copyMessage' }]);
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('same words');
    menu.mockClear();
    const link = document.createElement('a'); link.href = 'https://example.com/a'; c.root.append(link);
    await rightClick(link);
    expect(menu).not.toHaveBeenCalled();
    c.dispose(); c.root.remove();
  });
});
