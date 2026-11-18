/** @jsxImportSource solid-js */
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const messageId = '33333333-4444-4555-8666-777777777777';
const caption = 'Change 400g to 500ml?';

// The person's own delivered image (they sent it in a group the agent is in): its file is drawn once its original message is read, after the bubble is already on screen. The pinned
// copy of that bubble rests on it: it must move down with the bubble, not stay over the image that took its place.
it('keeps the pinned copy on its bubble when a delivered message gains its attachment', async () => {
  const context = createChatContext({ locale: () => 'en-US', layout: { agentConversation: true, preset: 'double', userGutter: 0 },
    selfIdentity: () => ({ userId: 'sender', displayName: 'Sender', guguNumber: null }) });
  const state = createChatState(context);
  const text = renderDeliveryEnvelope({ route: 'chat', from: 'Sender', fromId: 'user:sender', fromType: 'human', messageId: `msg:${messageId}`, at: '', chat: 'chat', chatKind: 'group',
    content: `[附件] photo.jpg (image/jpeg)\n[Size] 1\n[Kind] image\n[Caption]\n${caption}\n[Not on this computer. To read or change it: message_download_file {source_message_id: "msg:${messageId}"}]` });
  const turn: TranscriptTurn = { id: 'turn', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'delivered', seq: 0, role: 'user', text },
    { kind: 'message', id: 'answer', seq: 1, role: 'assistant', text: 'Looking.' },
  ] };
  state.transcript.history.seed([turn]);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;top:45px;left:0;width:640px;height:650px';
  const view = createChatView({ context, state, parent: host, pinUserMessages: true, stickToBottom: false,
    commands: { resolveAttachment: async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' } });
  const top = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)]
    .find(node => node.textContent?.includes(caption))?.getBoundingClientRect().top;
  const bubble = () => top('[data-agent-conversation-message="delivered"] [data-conversation-text]');
  const pinned = () => top('[data-pin-summary]');
  try {
    await until('the bubble and its pinned copy are drawn', () => bubble() !== undefined && pinned() !== undefined);
    await untilStable('the caption-only bubble settles', () => [bubble(), pinned()]);
    const before = bubble()!, offset = pinned()! - before;
    state.session.setDeliveredMessages(new Map([[messageId, { text: caption, attachments: [
      { id: `gugu-message-file://${messageId}`, name: 'photo.jpg', kind: 'image', href: `gugu-message-file://${messageId}` },
    ] }]]));
    await until('the image strip is drawn above the bubble', () => (bubble() ?? 0) > before + 20);
    await untilStable('the grown row settles', () => [bubble(), pinned()]);
    expect(pinned()! - bubble()!, 'the pinned copy moved with its bubble').toBeCloseTo(offset, 0);
  } finally {
    view.dispose(); state.dispose(); context.dispose(); host.remove();
  }
});
