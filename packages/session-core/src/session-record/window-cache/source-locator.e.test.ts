import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowBudget } from './read-budget.ts';
import { openWindowByteSource } from './file-source';
import { createRecordLocatorCapture, readCapturedRecordStart, readSourceLocator, sourceLocatorScope } from './source-locator';
import { TailReader } from '../sources/tail-reader';

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
  it('registers source and giant-record start while the raw capture blocks are consumed', async () => {
    const prefix = '{"meta":true}\n', record = '{"output":"' + 'x'.repeat(140_000) + '"}\r\n';
    const input = await fixture(prefix + record);
    const capture = createRecordLocatorCapture(input.context, 'codex', 'thread');
    const sizes: number[] = [], observed: unknown[] = [];
    const reader = new TailReader(input.path, 500, {
      async onBytes(path, file, bytes, position) { sizes.push(bytes.length); await capture(path, file, bytes, position); },
      onLines() {}, onRestart() {},
    }, () => {});
    await reader.readFromStart(() => observed.push(readSourceLocator(input.context.cacheDirectory, 'codex', 'thread', createWindowBudget())));
    await Promise.all(observed);
    expect(sizes).toHaveLength(3); expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    const saved = await readSourceLocator(input.context.cacheDirectory, 'codex', 'thread', createWindowBudget());
    if (saved.kind !== 'hit') throw new Error('Expected source locator');
    const source = await openWindowByteSource(input.path);
    try {
      expect(saved.locator.source).toEqual(await source.snapshot());
      expect(await readCapturedRecordStart(input.context.cacheDirectory, 'codex', 'thread', await source.snapshot(), createWindowBudget()))
        .toMatchObject({ kind: 'hit', range: { start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + record) - 2 } });
    } finally { await source.close(); reader.stop(); }
  });

  it('does not read source bytes while registering an already supplied raw block', async () => {
    const input = await fixture('{"text":"中文"}\n');
    const file = await open(input.path, 'r');
    const read = vi.spyOn(file, 'read').mockRejectedValue(new Error('No extra source reads'));
    try {
      await createRecordLocatorCapture(input.context, 'claude', 'session')(input.path, file, Buffer.from('{"text":"中文"}\n'), 0);
      expect(read).not.toHaveBeenCalled();
      expect(await readSourceLocator(input.context.cacheDirectory, 'claude', 'session', createWindowBudget())).toMatchObject({ kind: 'hit' });
    } finally { await file.close(); }
  });

  it('persists an unfinished record start before any complete-line callback', async () => {
    const input = await fixture('{"text":"unfinished');
    const line = vi.fn();
    const reader = new TailReader(input.path, 500, { onBytes: createRecordLocatorCapture(input.context, 'claude', 'active'), onLines: line, onRestart() {} }, () => {});
    await reader.readFromStart(line);
    expect(line).not.toHaveBeenCalled();
    expect(await readSourceLocator(input.context.cacheDirectory, 'claude', 'active', createWindowBudget())).toMatchObject({ kind: 'hit' });
    reader.stop();
  });

  it('keeps source metadata outside disposable projections and isolates native session ids', async () => {
    expect(sourceLocatorScope('claude', 'one')).not.toBe(sourceLocatorScope('codex', 'one'));
    const input = await fixture('{}\n'), file = await open(input.path, 'r');
    try { await createRecordLocatorCapture(input.context, 'codex', 'one')(input.path, file, Buffer.from('{}\n'), 0); }
    finally { await file.close(); }
    expect(await readSourceLocator(input.context.cacheDirectory, 'codex', 'two', createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    expect(await readSourceLocator(input.context.cacheDirectory, 'codex', 'one', createWindowBudget())).toMatchObject({ kind: 'hit' });
  });
});
