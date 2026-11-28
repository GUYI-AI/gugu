import { expect, it, vi } from 'vitest';
import { readOneVersion, uploadInParts, type WorkingCopyPart } from './working-copy-upload';
import type { AppFileEntry } from './app-runtime-protocol';

const chunk = (text: string, size = 4, etag: string | null = 'v1') => ({ size, etag, data: new TextEncoder().encode(text) });
function reader() {
  return { begin: vi.fn(() => true), piece: vi.fn(), stopped: () => new Error('stopped'), changing: () => new Error('changing') };
}

it('retries early EOF and rejects repeated incomplete reads', async () => {
  const read = vi.fn(async (offset: number) => chunk(offset === 0 ? 'ab' : ''));
  const sink = reader();
  await expect(readOneVersion(read, sink)).rejects.toThrow('changing');
  expect(sink.begin).toHaveBeenCalledTimes(2);
});

it('does not append a chunk whose size changes without an etag change', async () => {
  const sink = reader();
  await expect(readOneVersion(async offset => offset === 0 ? chunk('ab') : chunk('cd', 5), sink)).rejects.toThrow('changing');
  expect(sink.piece.mock.calls.map(call => new TextDecoder().decode(call[0]))).toEqual(['ab', 'ab']);
});

it('refuses overlong chunks before handing them to the sink', async () => {
  const sink = reader();
  await expect(readOneVersion(async () => chunk('abcde'), sink)).rejects.toThrow('changing');
  expect(sink.piece).not.toHaveBeenCalled();
});

it('still reads short nonempty chunks and empty files', async () => {
  const sink = reader();
  await expect(readOneVersion(async offset => chunk(offset === 0 ? 'ab' : 'cd'), sink)).resolves.toEqual({ size: 4, etag: 'v1' });
  await expect(readOneVersion(async () => chunk('', 0), reader())).resolves.toEqual({ size: 0, etag: 'v1' });
});

it('aborts instead of sending bytes when cancelled during Blob preparation', async () => {
  const controller = new AbortController();
  const source = new Blob(['data']);
  vi.spyOn(source, 'slice').mockReturnValue({ arrayBuffer: async () => { controller.abort(); return new TextEncoder().encode('data').buffer; } } as Blob);
  const write = vi.fn(async (_part: WorkingCopyPart) => ({ received: 4 }));
  await expect(uploadInParts(write, { chat: 'chat' }, [{ name: 'a', blob: source }], undefined, { signal: controller.signal })).rejects.toThrow('stopped');
  expect(write.mock.calls).toHaveLength(1);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ abort: true, data: '' });
});

it('cleans staging after a failed write without replacing the original failure', async () => {
  const failure = new Error('transport failed');
  const write = vi.fn(async (part: { abort?: boolean }) => { if (part.abort) throw new Error('cleanup failed'); throw failure; });
  await expect(uploadInParts(write, { chat: 'chat' }, [{ name: 'a', blob: new Blob(['data']) }], undefined)).rejects.toBe(failure);
  expect(write.mock.calls.map(([part]) => !!part.abort)).toEqual([false, true]);
});

it('cancellation during the final acknowledgement is not reported as success', async () => {
  const controller = new AbortController();
  const progress = vi.fn();
  const write = vi.fn(async (part: { abort?: boolean }) => { if (!part.abort) controller.abort(); return { received: 4 }; });
  await expect(uploadInParts(write, { chat: 'chat' }, [{ name: 'a', blob: new Blob(['data']) }], undefined, { signal: controller.signal, onProgress: progress })).rejects.toThrow('stopped');
  expect(progress).not.toHaveBeenCalled();
});

it.each([0, 4])('returns the published entry for a complete %i-byte upload', async size => {
  const entry: AppFileEntry = { id: 'a', workspace: 'session:test', name: 'a', savedName: 'a', contentType: 'text/plain', type: 'text',
    parentId: null, path: 'a', systemRole: null, suffix: '', displayName: 'a', claimedBy: null, appState: false,
    size, version: null, createdAt: null, updatedAt: null, createdBy: null, updatedBy: null, sourceMessageIds: [] };
  const write = vi.fn(async (_part: WorkingCopyPart) => ({ received: size, entry }));
  await expect(uploadInParts(write, { workspace: 'session:test' }, [{ name: 'a', blob: new Blob([new Uint8Array(size)]) }], undefined)).resolves.toEqual([entry]);
  expect(write).toHaveBeenCalledOnce();
});

it('rejects a short acknowledgement and cleans its staging identity', async () => {
  const write = vi.fn(async (_part: WorkingCopyPart) => ({ received: 1 }));
  await expect(uploadInParts(write, { chat: 'chat' }, [{ name: 'a', blob: new Blob(['data']) }], undefined)).rejects.toThrow('acknowledgement');
  expect(write.mock.calls[1]?.[0]).toMatchObject({ abort: true });
});
