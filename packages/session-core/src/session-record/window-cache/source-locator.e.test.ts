import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowBudget } from './read-budget.ts';
import { openWindowByteSource } from './file-source';
import { createBoundedRecordCapture, createRecordLocatorCapture, readCapturedRecordStart, readSourceLocator, sourceLocatorScope } from './source-locator';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-source-')); roots.push(root);
  const path = join(root, 'record.jsonl'), cacheDirectory = join(root, 'cache');
  await writeFile(path, text); await mkdir(cacheDirectory);
  const context = { cacheDirectory, scope: 'a'.repeat(64), conversationScope: 'b'.repeat(64), branchLineage: 'c'.repeat(64), decoderVersion: 1 };
  return { path, context, root };
}

describe('incremental native source locators', () => {
  it('rejects a same-inode same-size rewrite instead of transplanting the old record anchor', async () => {
    const prefix = '{"meta":true}\n';
    const original = '{"text":"' + 'x'.repeat(140_000) + '"}\n';
    const input = await fixture(original), capture = await createBoundedRecordCapture(input.context, 'codex', 'rewrite', input.path);
    try {
      const first = await capture.readNext(0, createWindowBudget());
      if (first.kind !== 'chunk') throw new Error('Unexpected reset');
      await writeFile(input.path, prefix + '{"text":"' + 'y'.repeat(140_000 - prefix.length) + '"}\n');
      await expect(capture.readNext(first.end, createWindowBudget())).rejects.toMatchObject({ code: 'record_start_unknown' });
    } finally { await capture.close(); }
  });

  it('restores the unfinished record start across a real capture close and reopen', async () => {
    const prefix = '{"meta":true}\n', input = await fixture(prefix + '{"text":"' + 'x'.repeat(140_000) + '"}\n');
    const first = await createBoundedRecordCapture(input.context, 'codex', 'restart', input.path);
    const part = await first.readNext(0, createWindowBudget()); await first.close();
    if (part.kind !== 'chunk') throw new Error('Unexpected reset');
    const second = await createBoundedRecordCapture(input.context, 'codex', 'restart', input.path);
    try {
      const next = await second.readNext(part.end, createWindowBudget());
      if (next.kind !== 'chunk') throw new Error('Unexpected reset');
      expect(await readCapturedRecordStart(input.context.cacheDirectory, 'codex', 'restart', next.source, createWindowBudget()))
        .toMatchObject({ kind: 'hit', range: { start: Buffer.byteLength(prefix), end: next.end } });
    } finally { await second.close(); }
  });

  it('does not invent a record start at an arbitrary nonzero resume position', async () => {
    const input = await fixture('x'.repeat(100_000));
    const capture = await createBoundedRecordCapture(input.context, 'codex', 'unknown', input.path);
    try { await expect(capture.readNext(65536, createWindowBudget())).rejects.toMatchObject({ code: 'record_start_unknown' }); }
    finally { await capture.close(); }
  });

  it('registers source and giant-record start while the raw capture blocks are consumed', async () => {
    const prefix = '{"meta":true}\n', record = '{"output":"' + 'x'.repeat(140_000) + '"}\r\n';
    const input = await fixture(prefix + record);
    const capture = await createBoundedRecordCapture(input.context, 'codex', 'thread', input.path);
    const sizes: number[] = [];
    for (let position = 0; position < Buffer.byteLength(prefix + record);) {
      const chunk = await capture.readNext(position, createWindowBudget());
      if (chunk.kind !== 'chunk') throw new Error('Unexpected source reset');
      sizes.push(chunk.bytes.length); position = chunk.end;
    }
    expect(sizes).toHaveLength(3); expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    const saved = await readSourceLocator(input.context.cacheDirectory, 'codex', 'thread', createWindowBudget());
    if (saved.kind !== 'hit') throw new Error('Expected source locator');
    const source = await openWindowByteSource(input.path);
    try {
      expect(saved.locator.source).toEqual(await source.snapshot());
      expect(await readCapturedRecordStart(input.context.cacheDirectory, 'codex', 'thread', await source.snapshot(), createWindowBudget()))
        .toMatchObject({ kind: 'hit', range: { start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + record) - 2 } });
    } finally { await source.close(); await capture.close(); }
  });

  it('does not read source bytes while registering an already supplied raw block', async () => {
    const input = await fixture('{"text":"中文"}\n');
    const file = await open(input.path, 'r');
    const read = vi.spyOn(file, 'read').mockRejectedValue(new Error('No extra source reads'));
    try {
      await createRecordLocatorCapture(input.context, 'claude', 'session')(input.path, file, Buffer.from('{"text":"中文"}\n'), 0, createWindowBudget());
      expect(read).not.toHaveBeenCalled();
      expect(await readSourceLocator(input.context.cacheDirectory, 'claude', 'session', createWindowBudget())).toMatchObject({ kind: 'hit' });
    } finally { await file.close(); }
  });

  it('persists an unfinished record start before any complete-line callback', async () => {
    const input = await fixture('{"text":"unfinished');
    const capture = await createBoundedRecordCapture(input.context, 'claude', 'active', input.path);
    await capture.readNext(0, createWindowBudget());
    expect(await readSourceLocator(input.context.cacheDirectory, 'claude', 'active', createWindowBudget())).toMatchObject({ kind: 'hit' });
    await capture.close();
  });

  it('keeps source metadata outside disposable projections and isolates native session ids', async () => {
    expect(sourceLocatorScope('claude', 'one')).not.toBe(sourceLocatorScope('codex', 'one'));
    const input = await fixture('{}\n'), file = await open(input.path, 'r');
    try { await createRecordLocatorCapture(input.context, 'codex', 'one')(input.path, file, Buffer.from('{}\n'), 0, createWindowBudget()); }
    finally { await file.close(); }
    expect(await readSourceLocator(input.context.cacheDirectory, 'codex', 'two', createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    expect(await readSourceLocator(input.context.cacheDirectory, 'codex', 'one', createWindowBudget())).toMatchObject({ kind: 'hit' });
  });
});
