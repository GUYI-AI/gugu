import fs, { mkdtempSync, readdirSync, rmSync, writeSync, openSync, closeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { INLINE_PAYLOAD_BYTES, TurnPayloadFiles, unbindTurnPayloadDirectory } from './session-turn-payloads';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'whole-turn-payload-')); });
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); unbindTurnPayloadDirectory(root); rmSync(root, { recursive: true, force: true }); });

it('syncs each whole file once and its batch directory once, independent of the number of logical blocks', () => {
  const original = fs.fsyncSync, synchronized: string[] = [];
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    synchronized.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); original(fd);
  });
  syncBuiltinESMExports();
  const files = new TurnPayloadFiles(root), first = Buffer.alloc(2 * INLINE_PAYLOAD_BYTES, 7), second = Buffer.alloc(3 * INLINE_PAYLOAD_BYTES, 8);
  files.putBytes(first); files.putBytes(second); files.putBytes(first);
  expect(files.counters.writtenFiles).toBe(2);
  expect(readdirSync(root)).toHaveLength(2);
  expect(synchronized).toEqual([]);
  files.durable();
  expect(synchronized).toEqual(['file', 'file', 'directory']);
  files.durable(); expect(synchronized).toHaveLength(3);
});

it('awaits the last file with at most two syncs in flight before syncing the directory', async () => {
  const pending: Array<{ fd: number; callback: (error: NodeJS.ErrnoException | null) => void }> = [];
  const completed: string[] = [], sync = fs.fsyncSync;
  vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => { pending.push({ fd, callback }); });
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    completed.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); sync(fd);
  });
  syncBuiltinESMExports();
  const files = new TurnPayloadFiles(root);
  for (const value of [1, 2, 3]) files.putBytes(Buffer.alloc(2 * INLINE_PAYLOAD_BYTES, value));
  const barrier = files.durableAsync(), sharedBarrier = files.durableAsync();
  expect(pending).toHaveLength(2); expect(completed).toEqual([]);
  const finish = () => { const call = pending.shift()!; sync(call.fd); completed.push('file'); call.callback(null); };
  finish(); await Promise.resolve();
  expect(pending).toHaveLength(2); expect(completed).toEqual(['file']);
  finish(); await Promise.resolve();
  expect(pending).toHaveLength(1); expect(completed).toEqual(['file', 'file']);
  finish(); await Promise.all([barrier, sharedBarrier]);
  expect(completed).toEqual(['file', 'file', 'file', 'directory']);
});

it('does not settle a failed barrier or sync its directory while a sibling file is still syncing', async () => {
  const pending: Array<{ fd: number; callback: (error: NodeJS.ErrnoException | null) => void }> = [];
  const sync = vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => { pending.push({ fd, callback }); });
  const directorySync = vi.spyOn(fs, 'fsyncSync');
  syncBuiltinESMExports();
  const files = new TurnPayloadFiles(root);
  for (const value of [1, 2, 3]) files.putBytes(Buffer.alloc(2 * INLINE_PAYLOAD_BYTES, value));
  const barrier = files.durableAsync();
  let settled = false;
  const outcome = barrier.then(() => { settled = true; }, error => { settled = true; return error as Error; });
  pending.shift()!.callback(Object.assign(new Error('file sync failed'), { code: 'EIO' }));
  await Promise.resolve();
  expect(settled).toBe(false); expect(pending).toHaveLength(1); expect(directorySync).not.toHaveBeenCalled();
  pending.shift()!.callback(null);
  expect(await outcome).toMatchObject({ message: 'file sync failed' });
  expect(directorySync).not.toHaveBeenCalled();
  sync.mockRestore(); syncBuiltinESMExports();
  await files.durableAsync();
  expect(directorySync).toHaveBeenCalledTimes(1);
});

it('keeps small shared objects out of physical files', () => {
  const files = new TurnPayloadFiles(root), text = 'shared output'.repeat(1000);
  const first = files.putText(text), second = files.putText(text);
  expect(first).toEqual(second);
  expect(files.staged.size).toBe(1);
  expect(files.readText(first)).toBe(text);
  expect(files.counters.writtenFiles).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

it('reuses bounded text encoding without losing descriptor children or retaining a settled writer', () => {
  const files = new TurnPayloadFiles(root), text = 'shared execute output'.repeat(100);
  const stringify = vi.spyOn(JSON, 'stringify');
  const first = files.putText(text);
  expect(files.putText(text)).toEqual(first);
  expect(stringify.mock.calls.filter(([value]) => value === text)).toHaveLength(1);
  const child = files.putText('owned child');
  expect(files.putText(text, [child])).toEqual(first);
  expect(files.staged.get(first.hash)!.children.get(child.hash)).toEqual(child);
  for (let index = 0; index < 64; index++) files.putText(`other ${index}`);
  files.putText(text);
  expect(stringify.mock.calls.filter(([value]) => value === text)).toHaveLength(3);
  files.clear(); files.putText(text);
  expect(stringify.mock.calls.filter(([value]) => value === text)).toHaveLength(4);
});

it('point-reads a late range under the original budget and checks the bytes actually requested', () => {
  const files = new TurnPayloadFiles(root), bytes = Buffer.alloc(1024 * 1024, 13), ref = files.putBytes(bytes);
  files.durable();
  const budget = createWindowBudget(), reader = new TurnPayloadFiles(root, (size, read, metadata) => budget.readSync(metadata ? 'indexBytes' : 'sourceBytes', size, read));
  expect(reader.readBytesRange(ref, 800000, 800016)).toEqual(bytes.subarray(800000, 800016));
  expect(budget.counters.sourceBytes).toBeLessThanOrEqual(65536);
  expect(budget.counters.indexBytes).toBeLessThanOrEqual(128);
  const path = join(root, `${ref.hash}.payload`), fd = openSync(path, 'r+');
  try { writeSync(fd, Buffer.from([99]), 0, 1, 800001); } finally { closeSync(fd); }
  expect(() => reader.readBytesRange(ref, 800000, 800016)).toThrow('integrity');
  expect(() => new TurnPayloadFiles(root).readBytesRange(ref, 800000, 800016)).toThrow('integrity');
});

it('refuses I/O before allocation when its range exceeds admission', () => {
  const files = new TurnPayloadFiles(root), ref = files.putBytes(Buffer.alloc(2 * INLINE_PAYLOAD_BYTES, 9)); files.durable();
  const budget = createWindowBudget({ sourceBytes: 0, indexBytes: 65536, decodedBytes: 524288, outputBytes: 131072, examinedRecords: 128 });
  const reader = new TurnPayloadFiles(root, (size, read, metadata) => budget.readSync(metadata ? 'indexBytes' : 'sourceBytes', size, read));
  expect(() => reader.readBytesRange(ref, 0, 16)).toThrow('budget exhausted');
  expect(budget.counters.sourceBytes).toBe(0);
  expect(reader.counters.readBytes).toBe(0);
});
