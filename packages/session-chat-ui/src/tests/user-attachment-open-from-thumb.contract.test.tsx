/** @jsxImportSource solid-js */
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { expect, it, vi } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';

// A sent picture opens by its chat-folder link (the authorized original, its source, its siblings — #1332/#1333). Drawn
// here already, its thumbnail goes with that link, so the file opens out of it as a chat message's picture does; without
// it the link re-read the bytes with nothing to open from (~0.5s, blank). A file's link carries no picture.
it('follows a picture\'s link with the thumbnail it drew, and a file\'s link alone', async () => {
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
  const calls: string[] = [];
  const onDrawnPictureLink = vi.fn((href: string) => { calls.push(`drawn ${href}`); });
  const onOpenLink = vi.fn((href: string) => { calls.push(`open ${href}`); return true; });
  const view = createChatView({ context, state, parent: host, commands: { onOpenLink, onDrawnPictureLink, resolveAttachment: async () => PIXEL } });
  const chip = (kind: string) => host.querySelector<HTMLButtonElement>(`button[data-attachment-chip][data-kind=${kind}]`);
  try {
    await until('both attachment chips are drawn', () => !!chip('image')?.querySelector('img') && !!chip('file'));
    chip('image')!.click();
    expect(onDrawnPictureLink).toHaveBeenCalledWith('gugu-file://item-photo?v=1', chip('image')!.querySelector('img'));
    expect(onOpenLink).toHaveBeenCalledWith('gugu-file://item-photo?v=1');
    chip('file')!.click();
    expect(onOpenLink).toHaveBeenLastCalledWith('gugu-file://item-notes?v=1');
    expect(calls, 'the picture is told before its link is followed; a file has none').toEqual([
      'drawn gugu-file://item-photo?v=1', 'open gugu-file://item-photo?v=1', 'open gugu-file://item-notes?v=1',
    ]);
  } finally {
    view.dispose(); state.dispose(); context.dispose(); host.remove();
  }
});
