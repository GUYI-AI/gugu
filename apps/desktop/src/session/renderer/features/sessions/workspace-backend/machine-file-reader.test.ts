import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readStreamed: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspace: { files: { readStreamed: h.readStreamed } } } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineCodec: () => ({ outbound: (ids: { workspaceId: string }) => ({ workspaceId: `there-${ids.workspaceId}` }) }) }));

import { machineFileReader } from './machine-file-reader';

const size = 1_000;
const chunk = vi.fn(async (_path: string, offset: number, length: number) => ({ size, etag: 'e1', bytes: new Uint8Array(Math.min(length, size - offset)).fill(1) }));
const streamed = (offset: number, length: number) => ({ success: true, data: { linked: true, size, etag: 'e1', offset, data: Buffer.alloc(Math.min(length, size - offset), 2).toString('base64') } });

beforeEach(() => { chunk.mockClear(); h.readStreamed.mockReset(); });

it('anchors a file from its start through the channel, then streams the rest of that version', async () => {
  h.readStreamed.mockImplementation(async (_d, _w, request: { offset: number; length: number }) => streamed(request.offset, request.length));
  const reader = machineFileReader('dev-b', 'w', chunk);
  expect((await reader.read('a.wav', 0, 400)).bytes[0]).toBe(1);
  expect((await reader.read('a.wav', 400, 400)).bytes[0]).toBe(2);
  expect((await reader.read('a.wav', 800, 400)).bytes.length).toBe(200);
  expect(chunk).toHaveBeenCalledOnce();
  expect(h.readStreamed.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
    ['dev-b', 'there-w', { path: 'a.wav', offset: 400, length: 400, size, etag: 'e1' }],
    ['dev-b', 'there-w', { path: 'a.wav', offset: 800, length: 400, size, etag: 'e1' }],
  ]);
  expect(reader.linked).toBe(true);
});

it('a machine no device link reaches is asked once, then read through its channel', async () => {
  h.readStreamed.mockResolvedValue({ success: true, data: { linked: false } });
  const reader = machineFileReader('dev-b', 'w', chunk);
  await reader.read('a.wav', 0, 400);
  await reader.read('a.wav', 400, 400);
  await reader.read('a.wav', 800, 400);
  expect(h.readStreamed).toHaveBeenCalledOnce();
  expect(chunk).toHaveBeenCalledTimes(3);
  expect(reader.linked).toBe(false);
});

it('a linked machine whose stream fails fails the read; this computer is read from its own disk', async () => {
  h.readStreamed.mockResolvedValue({ success: false, error: { type: 'internal_error', message: 'The machine refused the file read: gone' } });
  const reader = machineFileReader('dev-b', 'w', chunk);
  await reader.read('a.wav', 0, 400);
  await expect(reader.read('a.wav', 400, 400)).rejects.toThrow('refused');
  expect(chunk).toHaveBeenCalledOnce();
  const local = machineFileReader(null, 'w', chunk);
  await local.read('a.wav', 0, 400);
  await local.read('a.wav', 400, 400);
  expect(h.readStreamed).toHaveBeenCalledOnce();
});
