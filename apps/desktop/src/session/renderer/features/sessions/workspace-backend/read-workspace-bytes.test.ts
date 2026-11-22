import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readChunk: vi.fn(), readStreamed: vi.fn(), machine: { kind: 'local' } as { kind: 'local' } | { kind: 'remote'; deviceId: string } }));
vi.mock('./workspace-backend', () => ({ workspaceRpc: () => ({ files: { readChunk: h.readChunk } }), workspaceBackend: () => ({ machine: h.machine }) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspace: { files: { readStreamed: h.readStreamed } } } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineCodec: () => ({ outbound: (ids: { projectId: string; workspaceId: string }) => ({ projectId: `there-${ids.projectId}`, workspaceId: ids.workspaceId }) }) }));

import { readWorkspaceBytes } from './read-workspace-bytes';

const chunk = (size: number, bytes: number) => ({ success: true, data: { size, etag: 'e', data: Buffer.alloc(bytes, 1).toString('base64') } });
beforeEach(() => { h.readChunk.mockReset(); h.readStreamed.mockReset(); h.machine = { kind: 'local' }; });

it('reads a file chunk by chunk to its end', async () => {
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 512 * 1024)).mockResolvedValueOnce(chunk(700 * 1024, 188 * 1024));
  const parts = await readWorkspaceBytes('p', 'w', 'a.pdf');
  expect(new Blob(parts).size).toBe(700 * 1024);
  expect(h.readChunk.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([0, 512 * 1024]);
});

it('stops at the first chunk once the file is over the limit, before holding the rest', async () => {
  h.readChunk.mockResolvedValue(chunk(25 * 1024 * 1024, 512 * 1024));
  await expect(readWorkspaceBytes('p', 'w', 'huge.pdf', 20 * 1024 * 1024)).rejects.toMatchObject({ code: 'too-large' });
  expect(h.readChunk).toHaveBeenCalledTimes(1);
});

it('asks the rest of a large file several chunks at a time, and keeps them in order', async () => {
  const size = 5 * 512 * 1024 + 100;
  let inFlight = 0, most = 0;
  h.readChunk.mockReset();
  for (const k of [0, 1, 2, 3, 4, 5]) {
    h.readChunk.mockImplementationOnce(async () => {
      inFlight++; most = Math.max(most, inFlight);
      // Later chunks answer sooner: the parts come back out of order.
      await new Promise((resolve) => setTimeout(resolve, k === 0 ? 1 : 20 - k));
      inFlight--;
      return { success: true, data: { size, etag: 'e', data: Buffer.alloc(Math.min(512 * 1024, size - k * 512 * 1024), k).toString('base64') } };
    });
  }
  const bytes = new Uint8Array(await new Blob(await readWorkspaceBytes('p', 'w', 'a.png')).arrayBuffer());
  expect(bytes.length).toBe(size);
  expect([0, 1, 2, 3, 4, 5].map((k) => bytes[k * 512 * 1024])).toEqual([0, 1, 2, 3, 4, 5]);
  expect(h.readChunk.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([0, 1, 2, 3, 4, 5].map((k) => k * 512 * 1024));
  expect(most).toBe(4);
});

it('fails, rather than joining two versions, when the file changes size while it is read', async () => {
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 512 * 1024)).mockResolvedValueOnce(chunk(800 * 1024, 188 * 1024));
  await expect(readWorkspaceBytes('p', 'w', 'a.pdf')).rejects.toThrow('changed while it was read');
});

it('takes a first chunk already asked, and asks only the rest', async () => {
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 188 * 1024));
  const begun = Promise.resolve({ size: 700 * 1024, etag: 'e', bytes: new Uint8Array(512 * 1024), ms: 100 });
  const parts = await readWorkspaceBytes('p', 'w', 'a.png', Infinity, begun);
  expect(new Blob(parts).size).toBe(700 * 1024);
  expect(h.readChunk.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([512 * 1024]);
});

it('reads the rest of a file on a linked machine from one stream, of the version its first chunk read', async () => {
  const size = 9 * 1024 * 1024;
  h.machine = { kind: 'remote', deviceId: 'dev-b' };
  h.readChunk.mockResolvedValueOnce(chunk(size, 512 * 1024));
  h.readStreamed.mockImplementation(async (_d: string, _p: string, _w: string, request: { offset: number; length: number }) => ({ success: true,
    data: { linked: true, size, etag: 'e', offset: request.offset, data: Buffer.alloc(Math.min(request.length, size - request.offset), 2).toString('base64') } }));
  const parts = await readWorkspaceBytes('p', 'w', 'a.mp4');
  expect(new Blob(parts).size).toBe(size);
  expect(h.readChunk).toHaveBeenCalledOnce();
  expect(h.readStreamed.mock.calls.map((call) => [call[0], call[1], (call[3] as { offset: number }).offset, (call[3] as { etag: string }).etag]))
    .toEqual(Array.from({ length: 17 }, (_, k) => [ 'dev-b', 'there-p', (k + 1) * 512 * 1024, 'e' ]));
});

it('a machine no device link reaches reads its chunks through its channel', async () => {
  h.machine = { kind: 'remote', deviceId: 'dev-b' };
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 512 * 1024)).mockResolvedValueOnce(chunk(700 * 1024, 188 * 1024));
  h.readStreamed.mockResolvedValue({ success: true, data: { linked: false } });
  expect(new Blob(await readWorkspaceBytes('p', 'w', 'a.pdf')).size).toBe(700 * 1024);
  expect(h.readStreamed).toHaveBeenCalledOnce();
  expect(h.readChunk).toHaveBeenCalledTimes(2);
});

it('a stream that fails fails the read; it does not go on in chunks', async () => {
  h.machine = { kind: 'remote', deviceId: 'dev-b' };
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 512 * 1024));
  h.readStreamed.mockResolvedValue({ success: false, error: { type: 'internal_error', message: 'The SSH connection to this machine is not available (unreachable)' } });
  await expect(readWorkspaceBytes('p', 'w', 'a.pdf')).rejects.toThrow(/unreachable/);
  expect(h.readChunk).toHaveBeenCalledOnce();
});
