import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAttachmentUploads } from './attachment-uploads';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-recovery-')); roots.push(root);
  let now = 1;
  const spec = { uploadId: 'upload-1234', itemId: 'item-1234', name: 'a.txt', size: 4, sha256: hash('data') };
  const uploads = createAttachmentUploads({ now: () => now, maxAgeMs: 100 });
  return { root, spec, uploads, expire: () => { now = 200; } };
}

it('an unrelated corrupt upload receipt does not prevent a new attachment', async () => {
  const r = await fixture();
  const dir = path.join(r.root, '.gugu/attachments/.incoming/broken-1234');
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'upload.json'), '{broken');
  expect(await r.uploads.begin(r.root, r.spec)).toMatchObject({ state: 'uploading', received: 0 });
  expect(await readFile(path.join(dir, 'upload.json'), 'utf8')).toBe('{broken');
});

it.each(['null', '{"spec":null}', '{"spec":{},"received":0,"state":"uploading","expires":10}'])('reports invalid current metadata (%s) with its upload error code', async content => {
  const r = await fixture();
  const dir = path.join(r.root, '.gugu/attachments/.incoming', r.spec.uploadId);
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'upload.json'), content);
  await expect(r.uploads.status(r.root, r.spec)).rejects.toMatchObject({ code: 'invalid_payload' });
});

it('keeps a verified committed file available after its old staging receipt expires', async () => {
  const r = await fixture(); await r.uploads.begin(r.root, r.spec);
  await r.uploads.write(r.root, { ...r.spec, offset: 0, data: Buffer.from('data').toString('base64'), chunkSha256: hash('data') });
  await r.uploads.commit(r.root, r.spec); r.expire();
  expect(await r.uploads.status(r.root, r.spec)).toMatchObject({ state: 'committed', received: 4 });
});

it('still expires an unpublished partial upload', async () => {
  const r = await fixture(); await r.uploads.begin(r.root, r.spec); r.expire();
  await expect(r.uploads.status(r.root, r.spec)).rejects.toMatchObject({ code: 'upload_expired' });
});
