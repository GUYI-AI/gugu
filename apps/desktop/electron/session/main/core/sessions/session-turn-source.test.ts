import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import { encodeTurnValue } from './session-turn-codec';
import { TurnPayloadFiles, unbindTurnPayloadDirectory } from './session-turn-payloads';
import { createTurnJsonSource, readTurnJsonRange } from './session-turn-source';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'turn-source-')); });
afterEach(() => { unbindTurnPayloadDirectory(root); rmSync(root, { recursive: true, force: true }); });

it('projects canonical text, JSON-escaped raw output and binary images without storing another body copy', () => {
  const text = '中文🙂"line"\n'.repeat(5000), image = Buffer.alloc(45000, 72).toString('base64');
  const turn = { id: 'turn', referenceId: 'origin', seq: 0, items: [
    { kind: 'execute-tool-call', outputText: text, rawOutput: JSON.stringify({ aggregatedOutput: text, exitCode: 0 }, null, 2) },
    { kind: 'mcp-tool-call', images: [{ mimeType: 'image/png', data: image }] },
  ] };
  const files = new TurnPayloadFiles(root), encoded = encodeTurnValue(turn, files), before = files.counters.writtenBytes;
  const source = createTurnJsonSource(files, encoded), chunks: Buffer[] = [];
  for (let at = 0; at < source.bytes; at += 16384) {
    const budget = createWindowBudget();
    chunks.push(Buffer.from(readTurnJsonRange(root, source, at, Math.min(source.bytes, at + 16384), budget)));
    expect(budget.counters.indexBytes).toBeLessThanOrEqual(64 * 1024);
    expect(budget.counters.sourceBytes).toBeLessThanOrEqual(512 * 1024);
  }
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(turn);
  expect(files.counters.writtenBytes - before).toBeLessThan(Buffer.byteLength(image));
  const prior = files.counters.writtenBytes;
  createTurnJsonSource(files, encoded);
  expect(files.counters.writtenBytes).toBe(prior);
});

it('pages deeply nested raw JSON without an arbitrary escape-depth limit or an oversized literal page', () => {
  let rawOutput = 'quoted " output \\ ' + 'x'.repeat(2000);
  for (let at = 0; at < 11; at++) rawOutput = JSON.stringify({ rawOutput });
  const value = { rawOutput }, files = new TurnPayloadFiles(root), source = createTurnJsonSource(files, encodeTurnValue(value, files));
  const parts: Buffer[] = [];
  for (let at = 0; at < source.bytes; at += 16384) parts.push(Buffer.from(readTurnJsonRange(root, source, at,
    Math.min(at + 16384, source.bytes), createWindowBudget())));
  expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual(value);
});

it('shares bounded descriptor pages without reading unescaped bodies during source construction', () => {
  const value = { items: Array.from({ length: 64 }, (_, at) => ({ outputText: (`output-${at}-中文🙂`).repeat(100) })) };
  const files = new TurnPayloadFiles(root), encoded = encodeTurnValue(value, files), before = files.staged.size;
  const read = vi.spyOn(files, 'readEncodedTextRange');
  const source = createTurnJsonSource(files, encoded);
  expect(read).not.toHaveBeenCalled();
  // Body objects remain shared; a descriptor is no longer a separate registry row for every fragment.
  expect(files.staged.size - before).toBeLessThan(32);
  const pages = [...files.staged.values()].filter(object => object.kind === 2
    && (JSON.parse(object.data.subarray(1).toString()) as string).startsWith('{"kind":"page",'));
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.every(page => page.bytes <= 8193)).toBe(true);
  const output: Buffer[] = [];
  for (let at = 0; at < source.bytes; at += 16384) output.push(Buffer.from(readTurnJsonRange(root, source,
    at, Math.min(source.bytes, at + 16384), createWindowBudget())));
  expect(JSON.parse(Buffer.concat(output).toString('utf8'))).toEqual(value);
});

it.each(['sourceBytes', 'indexBytes'] as const)('keeps the default %s ceiling enforced by actual page/body reads', counter => {
  const files = new TurnPayloadFiles(root), value = { text: counter === 'sourceBytes' ? 'z'.repeat(100000) : 'short' };
  const source = createTurnJsonSource(files, encodeTurnValue(value, files)), budget = createWindowBudget();
  let failure: unknown;
  for (let at = 0; at < 1000; at++) {
    try { readTurnJsonRange(root, source, 0, source.bytes, budget); }
    catch (error) { failure = error; break; }
  }
  expect(failure).toMatchObject({ name: 'WindowBudgetExceeded', counter });
  expect(budget.counters.sourceBytes).toBeGreaterThan(0);
  expect(budget.counters.indexBytes).toBeGreaterThan(0);
  expect(budget.counters.sourceBytes).toBeLessThanOrEqual(WINDOW_LIMITS.sourceBytes);
  expect(budget.counters.indexBytes).toBeLessThanOrEqual(WINDOW_LIMITS.indexBytes);
});
