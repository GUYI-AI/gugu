import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { normalizeMessage } from './message.def';
import type { ChatMessage } from '@session-chat/model';

const id = '11111111-2222-4333-8444-555555555555';
const raw = renderDeliveryEnvelope({ route: 'chat', from: 'Sender', fromId: 'user:sender', messageId: `msg:${id}`, at: '', chat: 'chat', chatKind: 'dm',
  content: 'Can you read this?\n[Folder file gugu-file://file?v=1 — instructions for the agent]\n[Image attached at local path: /private/agent/image.png]' });
const item: ChatMessage = { kind: 'message', id: 'user-message', role: 'user', text: raw };

describe('delivered message presentation', () => {
  it('renders the authorized original image and caption instead of provider transport instructions', () => {
    const presentation = { text: 'Can you read this?', attachments: [{ id: `gugu-message-file://${id}`, name: 'image.png', kind: 'image' as const, href: 'gugu-file://file?v=1' }] };
    const shown = normalizeMessage(item, () => presentation);
    expect(shown.text).toBe('Can you read this?');
    expect(shown.attachments).toEqual(presentation.attachments);
    expect(JSON.stringify(shown.guguDelivery)).not.toContain('/private/agent');
    expect(item.text).toBe(raw);
  });
  it('hides machine-only hints while the original attachment is loading', () => {
    const shown = normalizeMessage(item);
    expect(shown.text).toBe('Can you read this?');
    expect(JSON.stringify(shown.guguDelivery)).not.toContain('Folder file');
    expect(JSON.stringify(shown.guguDelivery)).not.toContain('local path');
  });
  it.each([
    '[File at local path: /private/agent/deck.pdf]',
    '[Not on this computer. To read or change it: message_download_file {source_message_id: "msg:x"}]',
    '[Deleted: there are no bytes to fetch]',
  ])('hides the line saying where the bytes are: %s', line => {
    const text = renderDeliveryEnvelope({ route: 'chat', from: 'Sender', fromId: 'user:sender', messageId: `msg:${id}`, at: '', chat: 'chat', chatKind: 'dm',
      content: `Here it is\n[附件] deck.pdf (application/pdf)\n${line}` });
    expect(JSON.stringify(normalizeMessage({ ...item, text }).guguDelivery)).not.toContain(line.slice(1, 12));
  });
  it('keeps ordinary local user prose, including a quoted path, unchanged', () => {
    const text = 'Please inspect /private/agent/image.png';
    expect(normalizeMessage({ ...item, text }).text).toBe(text);
  });
});
