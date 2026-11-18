import { describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from './acp-chat-store';

const sessionNativeAttachment = vi.fn(async (_input: { attachmentId: string }) => ({ ok: true as const, value: 'data:image/png;base64,AQID' }));
const image = vi.fn(async (_path: string): Promise<{ success: boolean; dataUrl?: string }> => ({ success: true, dataUrl: 'data:image/png;base64,AQID' }));
const routes: Array<string | null> = [];
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: (machine: string | null) => { routes.push(machine); return { sessionTimeline: { sessionNativeAttachment }, app: { readUserImageDataUrl: image } }; } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: (id: string) => id.startsWith('remote-task') ? 'session-machine' : 'project-machine' } }));
vi.mock('./acp-chat-resource-manager', () => ({ resolveVisualEvidenceAttachmentDataUrl: () => undefined }));

const { resolveAttachmentDataUrl } = await import('./acp-attachment-image');

describe('task-page user image after a restart', () => {
  it('reads the image by its attachment id while no session runs', async () => {
    // What a reopened, stopped task gives the panel: a store with no live session.
    const store = { session: null, sessionId: 'task', runtimeSessionId: 'task', projectId: 'project' } as unknown as AcpChatStore;
    await expect(resolveAttachmentDataUrl(store, 'immutable-image')).resolves.toBe('data:image/png;base64,AQID');
    expect(sessionNativeAttachment).toHaveBeenCalledExactlyOnceWith({ attachmentId: 'immutable-image' });
  });
  it('reads an owner notification on the session machine, not the project default', async () => {
    const store = { runtimeSessionId: 'remote-task-image', projectId: 'project' } as AcpChatStore;
    await expect(resolveAttachmentDataUrl(store, 'path:/workspace/owner.png')).resolves.toBe('data:image/png;base64,AQID');
    expect(routes.at(-1)).toBe('session-machine');
    expect(image).toHaveBeenLastCalledWith('/workspace/owner.png');
  });
  it('allows a fresh read after the host refused or temporarily could not read a file', async () => {
    const store = { runtimeSessionId: 'remote-task-retry', projectId: 'project' } as AcpChatStore;
    image.mockResolvedValueOnce({ success: false });
    await expect(resolveAttachmentDataUrl(store, 'path:/workspace/retry.png')).resolves.toBeNull();
    await expect(resolveAttachmentDataUrl(store, 'path:/workspace/retry.png')).resolves.toBe('data:image/png;base64,AQID');
  });
  it('does not share a same-named file between different sessions', async () => {
    const first = { runtimeSessionId: 'remote-task-first', projectId: 'project' } as AcpChatStore;
    const second = { runtimeSessionId: 'remote-task-second', projectId: 'project' } as AcpChatStore;
    image.mockResolvedValueOnce({ success: true, dataUrl: 'data:image/png;base64,AAAA' });
    await expect(resolveAttachmentDataUrl(first, 'path:/workspace/same.png')).resolves.toBe('data:image/png;base64,AAAA');
    await expect(resolveAttachmentDataUrl(second, 'path:/workspace/same.png')).resolves.toBe('data:image/png;base64,AQID');
  });
});
