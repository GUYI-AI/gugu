import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TurnPayloadFiles, unbindTurnPayloadDirectory } from './session-turn-payloads';
import { encodeTurnValue, decodeTurnValue } from './session-turn-codec';

let root: string, files: TurnPayloadFiles;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'turn-codec-')); files = new TurnPayloadFiles(root); });
afterEach(() => { unbindTurnPayloadDirectory(root); rmSync(root, { recursive: true, force: true }); });

it('preserves every JSON value and a large tree without an oversized inline descriptor', () => {
  const value = { long: 'abc🙂\ud800'.repeat(20000), array: Array.from({ length: 2000 }, (_, i) => ({ [String(i)]: i })), empty: '', zero: 0, no: false, nil: null };
  const encoded = encodeTurnValue(value, files);
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(8192);
  expect(decodeTurnValue(encoded, files)).toEqual(value);
});

it('shares rawOutput aggregatedOutput with outputText while preserving raw JSON byte for byte', () => {
  const text = '"line"\n中文🙂'.repeat(3000), output = encodeTurnValue(text, files), before = files.counters.writtenBytes;
  const raw = JSON.stringify({ aggregatedOutput: text, exitCode: 0 }, null, 2);
  const encoded = encodeTurnValue(raw, files, 'rawOutput');
  expect(decodeTurnValue(output, files)).toBe(text);
  expect(decodeTurnValue(encoded, files)).toBe(raw);
  expect(files.counters.writtenBytes).toBe(before);
});

it('rejects damaged payload bytes instead of returning another version or empty history', () => {
  const ref = files.putText('hello'.repeat(20000));
  const path = join(root, readdirSync(root)[0]);
  const body = readFileSync(path); body[body.length - 1] ^= 1; writeFileSync(path, body);
  expect(() => files.readText(ref)).toThrow();
});

it('shares an image with its exact raw JSON and content-block spellings regardless of field order', () => {
  const data = Buffer.alloc(45000, 87).toString('base64');
  const value = { rawOutput: JSON.stringify({ untypedImageData: data }),
    contentBlocks: [{ content: { type: 'image', mimeType: 'image/png', data } }], images: [{ mimeType: 'image/png', data }] };
  const encoded = encodeTurnValue(value, files);
  expect(decodeTurnValue(encoded, files)).toEqual(value);
  expect(files.counters.writtenBytes).toBeLessThan(47000);
});
