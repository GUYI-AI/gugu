// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { SegmentCtx } from '@session-chat/core/units';
import type { ChatMessage } from '@session-chat/model';
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels';
import { messageFromItem } from './message.def';

it('hands committed owner files to the chat MessageBody without a streaming placeholder in an active turn', () => {
  const message: ChatMessage = { kind: 'message', id: 'notification', role: 'assistant', text: 'report.html', ownerNotification: {
    requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'active',
    files: [{ path: '/workspace/.gugu/attachments/request/report.html', name: 'report.html', mimeType: 'text/html', sizeBytes: 10, sha256: 'hash' }],
  } };
  const shown = messageFromItem(message, { active: true } as SegmentCtx);
  expect(shown.streaming).toBe(false);
  expect(shown.attachments).toBeUndefined();
  // A file-only note's text is the file's name: one file card, not the name said again.
  expect(shown.sentMessages).toEqual([expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111:file:0', content_type: 'attachment',
    content: attachmentEnvelope('report.html', 10, 'text/html'), session_file: { path: '/workspace/.gugu/attachments/request/report.html', sha256: 'hash' } })]);
  const words = messageFromItem({ ...message, text: 'Committed text', ownerNotification: { ...message.ownerNotification!, files: undefined } }, { active: true } as SegmentCtx);
  expect(words.streaming).toBe(false);
  expect(words.sentMessages).toEqual([expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', content_type: 'text', content: 'Committed text' })]);
});
