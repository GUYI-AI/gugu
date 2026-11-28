import { expect, it, vi } from 'vitest';
import { resumeTaskAttachment, type AttachmentUploadContext, type AttachmentUploadTransport } from '../../../../apps/desktop/src/lib/taskAttachmentUpload';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function rig() {
  const source = new Blob(['abcd']);
  const context: AttachmentUploadContext = {};
  const state = (received = 0, committed = false) => ({ state: committed ? 'committed' as const : 'uploading' as const, received, total: 4, chunkBytes: 2, workspacePath: '.gugu/attachments/item-1234/a.txt' });
  const transport: AttachmentUploadTransport = { begin: vi.fn(async () => state()), status: vi.fn(async () => state()),
    write: vi.fn(async chunk => state(chunk.offset + 2)), commit: vi.fn(async () => state(4, true)), abort: vi.fn(async () => {}) };
  const input = { source, context, transport, scope: 'workspace', itemId: 'item-1234', name: 'a.txt' };
  return { input, state, context, transport };
}

it('joins an already-started block when preparing a later block fails', async () => {
  const r = rig(), block = deferred<ReturnType<typeof r.state>>();
  r.transport.write = vi.fn(() => block.promise);
  const bad = Object.assign(new Blob(['abcd']), { slice: (start: number, _end: number) => start === 0 ? new Blob(['ab']) : Object.assign(new Blob(['cd']), { arrayBuffer: async () => { throw new Error('source disappeared'); } }) });
  r.context.source = bad;
  r.context.spec = { uploadId: 'upload-1234', itemId: r.input.itemId, name: r.input.name, size: 4, sha256: 'a'.repeat(64) };
  let ended = false;
  const uploading = resumeTaskAttachment(r.input).catch(error => { ended = true; return error; });
  await vi.waitFor(() => expect(r.transport.write).toHaveBeenCalledTimes(1));
  await Promise.resolve(); await Promise.resolve();
  const endedBeforeBlock = ended;
  block.resolve(r.state(2));
  expect((await uploading).message).toBe('source disappeared');
  expect(endedBeforeBlock).toBe(false);
});

it('restarts a cancelled partial upload on the next retry', async () => {
  const r = rig(), controller = new AbortController();
  r.transport.write = vi.fn(async chunk => { controller.abort(new Error('cancelled')); return r.state(chunk.offset + 2); });
  await expect(resumeTaskAttachment({ ...r.input, signal: controller.signal })).rejects.toThrow('cancelled');
  const prior = r.context.spec?.uploadId;
  r.transport.write = vi.fn(async chunk => r.state(chunk.offset + 2));
  expect(await resumeTaskAttachment(r.input)).toBe(r.state().workspacePath);
  expect(r.context.spec?.uploadId).not.toBe(prior);
  expect(r.transport.begin).toHaveBeenCalledTimes(2);
  expect(r.transport.status).not.toHaveBeenCalled();
});

it('refuses an incomplete committed receipt before returning its path', async () => {
  const r = rig(); r.transport.begin = vi.fn(async () => r.state(1, true));
  await expect(resumeTaskAttachment(r.input)).rejects.toThrow('acknowledgement');
});

it('retries the same upload after a transient block failure', async () => {
  const r = rig(); r.transport.write = vi.fn(async () => { throw new Error('connection lost'); });
  await expect(resumeTaskAttachment(r.input)).rejects.toThrow('connection lost');
  const prior = r.context.spec?.uploadId;
  r.transport.status = vi.fn(async () => r.state(2));
  r.transport.write = vi.fn(async chunk => r.state(chunk.offset + 2));
  expect(await resumeTaskAttachment(r.input)).toBe(r.state().workspacePath);
  expect(r.context.spec?.uploadId).toBe(prior);
  expect(r.transport.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ offset: 2 }));
});
