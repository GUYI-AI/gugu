import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkspaceUploads } from './workspace-transfer';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('an abort request removes staged replacement bytes and preserves the destination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-abort-')); roots.push(root);
  await writeFile(path.join(root, 'a.txt'), 'original');
  const uploads = createWorkspaceUploads();
  const request = { path: 'a.txt', uploadId: 'upload', offset: 0, data: Buffer.from('ab').toString('base64'), total: 4, final: false, expectedEtag: '*' };
  await uploads.write(root, request);
  await uploads.write(root, { ...request, offset: 2, data: '', abort: true });
  expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('original');
  expect(await readdir(root)).toEqual(['a.txt']);
  await expect(uploads.write(root, { ...request, offset: 2 })).rejects.toMatchObject({ code: 'upload_lost' });
});

it('an abort for a different file cannot discard the active upload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-abort-')); roots.push(root);
  const uploads = createWorkspaceUploads();
  const request = { path: 'a.txt', uploadId: 'upload', offset: 0, data: Buffer.from('ab').toString('base64'), total: 4, final: false, expectedEtag: null };
  await uploads.write(root, request);
  await expect(uploads.write(root, { ...request, path: 'b.txt', data: '', abort: true })).rejects.toMatchObject({ code: 'invalid_payload' });
  await uploads.write(root, { ...request, offset: 2, data: Buffer.from('cd').toString('base64'), final: true });
  expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('abcd');
});
