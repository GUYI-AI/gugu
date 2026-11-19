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
  expect(synchronized).toEqual(['file', 'file']);
  files.durable();
  expect(synchronized).toEqual(['file', 'file', 'directory']);
  files.durable(); expect(synchronized).toHaveLength(3);
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
