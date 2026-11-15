import { describe, expect, it, vi } from 'vitest';
import { readNativeAttachment } from './native-attachment';

const ref = { id: 'immutable-image', name: 'photo.png', mimeType: 'image/png' as const };
describe('native user attachment read', () => {
  it('reads a restarted task image by its attachment id alone', async () => {
    const download = vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) }));
    expect(await readNativeAttachment({ attachmentId: ref.id }, download)).toEqual({ ok: true, value: 'data:image/png;base64,AQID' });
    expect(download).toHaveBeenCalledExactlyOnceWith(ref.id);
  });
  it('keeps a missing or unreadable object as an explicit failure', async () => {
    expect(await readNativeAttachment({ attachmentId: ref.id }, async () => { throw new Error('object missing'); }))
      .toEqual({ ok: false, error: { code: 'attachment_unavailable', message: 'object missing' } });
  });
});
