import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readChunk: vi.fn() }));
vi.mock('./workspace-backend', () => ({ workspaceRpc: () => ({ files: { readChunk: h.readChunk } }) }));

import { readWorkspaceBytes } from './read-workspace-bytes';

const chunk = (size: number, bytes: number) => ({ success: true, data: { size, etag: 'e', data: Buffer.alloc(bytes, 1).toString('base64') } });
beforeEach(() => h.readChunk.mockReset());

it('reads a file chunk by chunk to its end', async () => {
  h.readChunk.mockResolvedValueOnce(chunk(700 * 1024, 512 * 1024)).mockResolvedValueOnce(chunk(700 * 1024, 188 * 1024));
  const parts = await readWorkspaceBytes('p', 'w', 'a.pdf');
  expect(new Blob(parts).size).toBe(700 * 1024);
  expect(h.readChunk.mock.calls.map((call) => (call[2] as { offset: number }).offset)).toEqual([0, 512 * 1024]);
});

it('stops at the first chunk once the file is over the limit, before holding the rest', async () => {
  h.readChunk.mockResolvedValue(chunk(25 * 1024 * 1024, 512 * 1024));
  await expect(readWorkspaceBytes('p', 'w', 'huge.pdf', 20 * 1024 * 1024)).rejects.toMatchObject({ code: 'too-large' });
  expect(h.readChunk).toHaveBeenCalledTimes(1);
});
