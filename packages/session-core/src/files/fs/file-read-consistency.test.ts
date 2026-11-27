import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileSystem } from './file-system';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function file(text = 'abcdef') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'gugu-consistent-read-')); roots.push(root);
  const target = path.join(root, 'file.txt'); await fs.writeFile(target, text); return target;
}

it('continues short positional reads until the opened file is complete', async () => {
  const target = await file();
  const open = fs.open.bind(fs); let closed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 2), position)) as typeof handle.read;
    handle.close = async () => { closed = true; await close(); };
    return handle;
  });
  const result = await new FileSystem().readText(target);
  expect(result).toMatchObject({ success: true, data: { content: 'abcdef', truncated: false, totalSize: 6 } });
  expect(closed).toBe(true);
});

it('uses the size of the opened file when the pathname changes before open', async () => {
  const target = await file('old'); const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    await fs.writeFile(target, 'replacement text'); return open(...args);
  });
  expect(await new FileSystem().readText(target)).toMatchObject({ success: true, data: { content: 'replacement text', totalSize: 16 } });
});

it('applies the byte limit to a file that grew before it was opened', async () => {
  const target = await file('old'); const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    await fs.writeFile(target, 'replacement text'); return open(...args);
  });
  expect(await new FileSystem().readText(target, { maxBytes: 4 })).toMatchObject({ success: true, data: { content: '', truncated: true, totalSize: 16 } });
});

it('refuses an early EOF instead of labeling a partial file complete', async () => {
  const target = await file(); const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle); let calls = 0;
    handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => ++calls === 1
      ? read(buffer, offset, Math.min(length, 2), position) : Promise.resolve({ bytesRead: 0, buffer })) as typeof handle.read;
    return handle;
  });
  expect(await new FileSystem().readText(target)).toMatchObject({ success: false, error: { code: 'FILE_CHANGED' } });
});

it('refuses a file modified during the read', async () => {
  const target = await file(); const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle); let changed = false;
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, Math.min(length, 2), position);
      if (!changed) { changed = true; await fs.writeFile(target, 'changed content'); }
      return result;
    }) as typeof handle.read;
    return handle;
  });
  expect(await new FileSystem().readText(target)).toMatchObject({ success: false, error: { code: 'FILE_CHANGED' } });
});
