import { expect, it, vi } from 'vitest';
import { RemoteTransfers, type TransferRpc } from './remote-transfers';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';

function fixture() {
  let published = 'original';
  const rpc: TransferRpc = {
    listWorkspace: vi.fn(async () => ({ entries: [{ name: 'a.txt', path: '/ws/a.txt', kind: 'file' as const, isDirectory: false, size: 8 }] })),
    createWorkspaceEntry: vi.fn(async (_device, request) => { if (request.kind === 'file') published = ''; return { path: `${request.dir}/${request.name}` }; }),
    writeWorkspaceFile: vi.fn(async (_device, request) => { if (request.final) published = request.data; return { received: request.total }; }),
  };
  const transfers = new RemoteTransfers({ rpc: () => rpc, deviceId: 'device', sessionId: 'session', confirmReplace: async () => true });
  return { rpc, transfers, published: () => published };
}

it('keeps the existing destination when preparing replacement bytes fails', async () => {
  const f = fixture();
  const result = await f.transfers.upload('/ws', [{ segments: ['a.txt'], size: 4, slice: async () => { throw new Error('source gone'); } }], 'upload');
  expect(result?.status).toBe('failed');
  expect(f.published()).toBe('original');
});

it('does not send a final replacement when cancelled during source preparation', async () => {
  const f = fixture();
  const result = await f.transfers.upload('/ws', [{ segments: ['a.txt'], size: 4, slice: async () => { f.transfers.items[0]!.cancel(); return new Uint8Array(4); } }], 'upload');
  expect(result?.status).toBe('cancelled');
  expect(f.published()).toBe('original');
  expect(f.rpc.writeWorkspaceFile).not.toHaveBeenCalled();
});

it('a rejected block preserves the original and requests staging cleanup', async () => {
  const f = fixture();
  vi.mocked(f.rpc.writeWorkspaceFile).mockRejectedValueOnce(new Error('offline'));
  const result = await f.transfers.upload('/ws', [{ segments: ['a.txt'], size: REMOTE_WORKSPACE_CHUNK_BYTES + 1, slice: async (start, end) => new Uint8Array(end - start) }], 'upload');
  expect(result?.status).toBe('failed');
  expect(f.published()).toBe('original');
  expect(f.rpc.writeWorkspaceFile).toHaveBeenLastCalledWith('device', expect.objectContaining({ abort: true }));
});

it('still creates an empty replacement and completes a nonempty upload', async () => {
  const f = fixture();
  const empty = await f.transfers.upload('/ws', [{ segments: ['a.txt'], size: 0, slice: vi.fn() }], 'upload');
  expect(empty?.status).toBe('done'); expect(f.published()).toBe('');
  const done = await f.transfers.upload('/ws', [{ segments: ['a.txt'], size: 4, slice: async () => new Uint8Array([1, 2, 3, 4]) }], 'upload');
  expect(done?.status).toBe('done'); expect(done?.done).toBe(4);
  expect(f.published()).toBe('AQIDBA==');
});
