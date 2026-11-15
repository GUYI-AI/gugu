import type { AttachmentRef } from '@gugu/session-core/acp/client';
import type { SessionTimelineResult } from './service';

export type NativeAttachmentRequest = { attachmentId: string };
type StoredAttachment = { ref: AttachmentRef; data: Uint8Array };

/** Desktop and phone read a user image the same way: by its attachment id from this machine's store, running session or not. */
export function nativeAttachment(input: NativeAttachmentRequest): Promise<SessionTimelineResult<string>> {
  return readNativeAttachment(input, downloadStored);
}

export async function readNativeAttachment(input: NativeAttachmentRequest, download: (id: string) => Promise<StoredAttachment>): Promise<SessionTimelineResult<string>> {
  try {
    const stored = await download(input.attachmentId);
    return { ok: true, value: `data:${stored.ref.mimeType};base64,${Buffer.from(stored.data).toString('base64')}` };
  } catch (error) {
    return { ok: false, error: { code: 'attachment_unavailable', message: (error as Error)?.message ?? String(error) } };
  }
}

async function downloadStored(id: string): Promise<StoredAttachment> {
  const { getAcpRuntimeClient } = await import('../acp/runtime-process/host');
  const result = await (await getAcpRuntimeClient()).downloadAttachment({ id });
  if (!result.success) throw new Error('图片附件无法读取');
  return { ref: result.data.meta, data: await result.data.bytes() };
}
