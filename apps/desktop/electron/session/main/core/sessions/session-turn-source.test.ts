import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import { encodeTurnValue } from './session-turn-codec';
import { TurnPayloadFiles, unbindTurnPayloadDirectory } from './session-turn-payloads';
import { createTurnJsonSource, jsonSpecialBytes, readTurnJsonRange } from './session-turn-source';

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

function random(seed: number) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Quote and backslash, their neighbours, the same low bits with the high bit set (0xa2, 0xdc), and bytes around them.
const NEAR = [0x22, 0x5c, 0x21, 0x23, 0x5b, 0x5d, 0xa2, 0xdc, 0x00, 0x7f, 0x80, 0xff, 0x1c, 0x9c];
const naive = (bytes: Uint8Array) => bytes.reduce((count, byte) => count + Number(byte === 34 || byte === 92), 0);

it.each([1, 2, 3, 4, 5, 6])('counts quotes and backslashes exactly at any length, alignment and density (seed %i)', seed => {
  const next = random(seed), backing = Buffer.alloc(40000 + 8);
  for (let run = 0; run < 300; run += 1) {
    const density = [0, 0.0005, 0.002, 0.01, 0.1, 0.5, 1][Math.floor(next() * 7)];
    const length = next() < 0.3 ? Math.floor(next() * 40) : Math.floor(next() * 40000), offset = Math.floor(next() * 8);
    const bytes = backing.subarray(offset, offset + length);
    for (let at = 0; at < length; at += 1) bytes[at] = next() < density ? (next() < 0.5 ? 0x22 : 0x5c)
      : next() < 0.3 ? NEAR[Math.floor(next() * NEAR.length)] : Math.floor(next() * 256);
    expect(jsonSpecialBytes(bytes)).toBe(naive(bytes));
  }
});

it.each([16, 17, 18])('counts exactly where sparse search hands over to the word scan (%i specials)', specials => {
  for (let offset = 0; offset < 4; offset += 1) for (const tail of [0, 1, 2, 3, 4, 5]) {
    const bytes = Buffer.alloc(offset + 64 + tail, 0x61).subarray(offset);
    for (let at = 0; at < specials; at += 1) bytes[(at * 7) % bytes.length] = at % 2 ? 0x5c : 0x22;
    bytes[bytes.length - 1] = 0x22;
    expect(jsonSpecialBytes(bytes)).toBe(naive(bytes));
  }
});

it.each([1, 2, 3])('projects nested raw JSON with dense escapes byte for byte (seed %i)', seed => {
  const next = random(seed), pieces = ['"', '\\', 'a', ' ', '\n', '中', '🙂', '\\"', '{"k":"v"}'];
  for (let run = 0; run < 6; run += 1) {
    let text = '';
    while (text.length < 30000 * next() + 2000) text += pieces[Math.floor(next() * pieces.length)];
    let rawOutput = JSON.stringify({ aggregatedOutput: text, exitCode: 0 }, null, 2);
    for (let layer = Math.floor(next() * 3); layer > 0; layer -= 1) rawOutput = JSON.stringify({ rawOutput });
    const value = { items: [{ kind: 'execute-tool-call', outputText: text, rawOutput }] };
    const files = new TurnPayloadFiles(root), source = createTurnJsonSource(files, encodeTurnValue(value, files));
    expect(source.bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    const parts: Buffer[] = [];
    for (let at = 0; at < source.bytes;) {
      const end = Math.min(source.bytes, at + 1 + Math.floor(next() * 20000));
      parts.push(Buffer.from(readTurnJsonRange(root, source, at, end, createWindowBudget()))); at = end;
    }
    expect(Buffer.concat(parts).equals(Buffer.from(JSON.stringify(value)))).toBe(true);
    unbindTurnPayloadDirectory(root); rmSync(root, { recursive: true, force: true }); root = mkdtempSync(join(tmpdir(), 'turn-source-'));
  }
});
