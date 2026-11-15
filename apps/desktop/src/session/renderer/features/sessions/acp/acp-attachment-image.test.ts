import { describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from './acp-chat-store';

const sessionNativeAttachment = vi.fn(async (_input: { attachmentId: string }) => ({ ok: true as const, value: 'data:image/png;base64,AQID' }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionNativeAttachment } }) }));
vi.mock('./acp-chat-resource-manager', () => ({ resolveVisualEvidenceAttachmentDataUrl: () => undefined }));

const { resolveAttachmentDataUrl } = await import('./acp-attachment-image');

describe('task-page user image after a restart', () => {
  it('reads the image by its attachment id while no session runs', async () => {
    // What a reopened, stopped task gives the panel: a store with no live session.
    const store = { session: null, sessionId: 'task', runtimeSessionId: 'task', projectId: 'project' } as unknown as AcpChatStore;
    await expect(resolveAttachmentDataUrl(store, 'immutable-image')).resolves.toBe('data:image/png;base64,AQID');
    expect(sessionNativeAttachment).toHaveBeenCalledExactlyOnceWith({ attachmentId: 'immutable-image' });
  });
});
