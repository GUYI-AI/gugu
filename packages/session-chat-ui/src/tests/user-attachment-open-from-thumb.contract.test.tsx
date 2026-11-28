/** @jsxImportSource solid-js */
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { expect, it, vi } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';

// A sent picture opens in the viewer at once, out of the thumbnail drawn here, as a chat message's picture does: the host
// gets the picture with the click and opens it before any read. Following its link first read the file again with
// nothing on screen; repeated clicks each queued one more opening. A file opens where its link says.
it('opens a picture with the thumbnail it drew, and follows a file\'s link', async () => {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const turn: TranscriptTurn = { id: 'turn', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
    // As a task message keeps what was sent with it: the chat-folder versions, drawn by their link.
    { kind: 'message', id: 'sent', seq: 0, role: 'user', text: 'look', files: [
      { itemId: 'item-photo', version: 1, name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
      { itemId: 'item-notes', version: 1, name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 1 },
    ] },
  ] };
  state.transcript.history.seed([turn]);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:600px';
  const onViewAttachment = vi.fn();
  const onOpenLink = vi.fn(() => true);
  const view = createChatView({ context, state, parent: host, commands: { onOpenLink, onViewAttachment, resolveAttachment: async () => PIXEL } });
  const chip = (kind: string) => host.querySelector<HTMLButtonElement>(`button[data-attachment-chip][data-kind=${kind}]`);
  try {
    await until('both attachment chips are drawn', () => !!chip('image')?.querySelector('img') && !!chip('file'));
    chip('image')!.click();
    expect(onViewAttachment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      attachment: expect.objectContaining({ name: 'photo.jpg', href: 'gugu-file://item-photo?v=1' }), thumb: chip('image')!.querySelector('img'),
    }));
    expect(onOpenLink, 'a picture does not follow its link').not.toHaveBeenCalled();
    chip('file')!.click();
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('gugu-file://item-notes?v=1');
    expect(onViewAttachment).toHaveBeenCalledOnce();
  } finally {
    view.dispose(); state.dispose(); context.dispose(); host.remove();
  }
});
