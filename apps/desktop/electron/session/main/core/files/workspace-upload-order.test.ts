import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceUploads } from './workspace-transfer';

const io = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), appendFile: io.append }));
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-order-')); roots.push(root);
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.append.mockReset(); io.append.mockImplementation(fs.appendFile);
  const uploads = createWorkspaceUploads();
  const chunk = { path: 'a.txt', uploadId: 'first', offset: 0, data: Buffer.from('ab').toString('base64'), total: 4, final: false, expectedEtag: null };
  return { root, uploads, chunk, fs };
}

it('does not append a duplicate concurrently admitted offset twice', async () => {
  const r = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  io.append.mockImplementationOnce(async (...args) => { await gate; return r.fs.appendFile(...args as Parameters<typeof appendFile>); });
  const first = r.uploads.write(r.root, r.chunk);
  await vi.waitFor(() => expect(io.append).toHaveBeenCalledTimes(1));
  const second = r.uploads.write(r.root, r.chunk).catch(error => error);
  const other = await r.uploads.write(r.root, { ...r.chunk, path: 'b.txt', uploadId: 'other', total: 2, final: true });
  expect(other.committed?.size).toBe(2);
  release(); await first;
  expect((await second).code).toBe('upload_lost');
  await r.uploads.write(r.root, { ...r.chunk, offset: 2, data: Buffer.from('cd').toString('base64'), final: true });
  expect(await readFile(path.join(r.root, 'a.txt'), 'utf8')).toBe('abcd');
});

it('abort waits for a started append and leaves no recreated staging file', async () => {
  const r = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  io.append.mockImplementationOnce(async (...args) => { await gate; return r.fs.appendFile(...args as Parameters<typeof appendFile>); });
  const writing = r.uploads.write(r.root, r.chunk);
  await vi.waitFor(() => expect(io.append).toHaveBeenCalledTimes(1));
  const abort = r.uploads.abort(r.chunk.uploadId);
  // 让另一份上传完成一轮 IO，确保 abort 有机会完成，而不是靠时间猜测。
  await r.uploads.write(r.root, { ...r.chunk, path: 'b.txt', uploadId: 'other', total: 2, final: true });
  release(); await writing; await abort;
  expect((await readdir(r.root)).filter(name => name.endsWith('.gugu-tmp'))).toEqual([]);
});

it('refuses a modified staging file instead of publishing a wrong-length save', async () => {
  const r = await fixture(); await r.uploads.write(r.root, r.chunk);
  const temp = (await readdir(r.root)).find(name => name.endsWith('.gugu-tmp'))!;
  await writeFile(path.join(r.root, temp), 'extra staging data');
  await expect(r.uploads.write(r.root, { ...r.chunk, offset: 2, data: Buffer.from('cd').toString('base64'), final: true })).rejects.toMatchObject({ code: 'upload_lost' });
  expect((await readdir(r.root)).filter(name => name.endsWith('.gugu-tmp'))).toEqual([]);
});
