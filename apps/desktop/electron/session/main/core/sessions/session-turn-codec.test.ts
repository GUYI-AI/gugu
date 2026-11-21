import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TurnPayloadFiles, unbindTurnPayloadDirectory } from './session-turn-payloads';
import { encodeTurnValue, decodeTurnValue, sharedBodies, sharedJson } from './session-turn-codec';

const uuid = vi.hoisted(() => ({ next: undefined as string | undefined }));
vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuid.next ?? actual.randomUUID() };
});

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

// A seeded generator keeps failures reproducible: the seed is in the test name.
function random(seed: number) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const PIECES = ['a', 'Z', ' ', '"', '\\', '/', '\n', '\r', '\t', '\b', '\f', '\u0000', '\u001f', '\u007f', '\u2028', '\u2029', 'é', 'e\u0301',
  '中文', '🙂', '\ud800', '\udfff', '\\u00e9', '\\"', '{', '}', '[', ']', ':', ',', '"aggregatedOutput"', '\u0000gugu-shared-body:'];
// The property runs pin the placeholder token, so bodies and other strings can spell it, whole placeholders included.
const TOKEN = '6f0c2b1e-9d4a-4c3b-8e7f-0a1b2c3d4e5f';
const TOKEN_PIECES = [TOKEN, `\u0000gugu-shared-body:${TOKEN}:0`, `\u0000gugu-shared-body:${TOKEN}:1`, `x${TOKEN}`];
const KEYS = ['aggregatedOutput', 'stdout', '__proto__', 'constructor', '1', '0', 'b', 'a', '', '中', 'é', 'e\u0301', '"', '\\'];
const NUMBERS = [0, -1, 1.5, 0.1, 1e21, 5e-7, 2 ** 53 + 2, -1e-300];
function generator(next: () => number) {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const piece = () => next() < 0.002 ? pick(TOKEN_PIECES) : pick(PIECES);
  const text = (min: number) => { let one = ''; while (one.length < min || next() < 0.3) one += piece(); return one; };
  const tree = (depth: number, bodies: readonly string[]): unknown => {
    const roll = next();
    if (depth > 0 && roll < 0.25) return Object.fromEntries(Array.from({ length: Math.floor(next() * 5) },
      () => [next() < 0.8 ? pick(KEYS) : text(1), tree(depth - 1, bodies)]));
    if (depth > 0 && roll < 0.4) return Array.from({ length: Math.floor(next() * 5) }, () => tree(depth - 1, bodies));
    if (roll < 0.6) return pick(bodies);
    if (roll < 0.7) return next() < 0.5 ? pick(bodies) + text(0) : text(0) + JSON.stringify(pick(bodies));
    if (roll < 0.85) return pick(NUMBERS);
    if (roll < 0.87) return pick(TOKEN_PIECES);
    return roll < 0.9 ? text(0) : pick([true, false, null]);
  };
  return { pick, text, tree };
}

/** The spellings a provider may send: canonical at either indent, and near misses the exact check must refuse. */
function spellings(value: unknown, bodies: readonly string[]): string[] {
  const two = JSON.stringify(value, null, 2), zero = JSON.stringify(value), body = JSON.stringify(bodies[0]);
  const all = [two, zero, JSON.stringify(value, null, 4), JSON.stringify(value, null, '\t'), ` ${two}`, `${zero}\n`,
    two.replaceAll('é', '\\u00e9'), zero.replaceAll('/', '\\/'), two.replaceAll('\\u001f', '\\u001F'), zero.replaceAll('1.5', '1.50'),
    `{"b":${body},"1":${body}}`, `{"b":${body},"b":0}`, `{${body}:${body}}`, `[${body},${body}]`, `[${body}, ${body}]`, `{"x":[${body}]}`,
    JSON.stringify({ inner: JSON.stringify({ aggregatedOutput: bodies[0] }) }), JSON.stringify({ wrap: `x${bodies[0]}` }, null, 2),
    JSON.stringify([`x"${bodies[0]}`, bodies[1]]), JSON.stringify({ [`"${bodies[1]}`]: bodies[1] })];
  if (zero.startsWith('{') && zero !== '{}') all.push(`{"a":1,${zero.slice(1)}`.replace('{"a":1,', '{"a":1,"a":1,'));
  let deep: unknown = bodies[0];
  for (let i = 0; i < 40; i += 1) deep = i % 2 ? [deep] : { a: deep };
  all.push(JSON.stringify(deep, null, 2), JSON.stringify(deep));
  return all;
}

it.each([1, 2, 3, 4, 5, 6, 7, 8])('shares a sibling body inside raw JSON only when the raw text is restored byte for byte (seed %i)', seed => {
  const { tree, text } = generator(random(seed));
  let shared = 0, refused = 0, tokenInBody = 0;
  uuid.next = TOKEN;
  try { for (let run = 0; run < 40; run += 1) {
    const bodies = [text(1024), text(1024)];
    for (const raw of spellings(tree(4, bodies), bodies)) {
      const fast = sharedJson(raw, bodies);
      let exact: unknown;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && [2, 0].some(indent => JSON.stringify(parsed, null, indent) === raw)) exact = parsed;
      } catch { /* not JSON */ }
      if (fast) {
        shared += 1;
        if (raw.includes(TOKEN)) tokenInBody += 1;
        // The restored tree serializes back to the very same code units, keeps key order and own "__proto__" keys.
        expect(JSON.stringify(fast.parsed, null, fast.indent) === raw).toBe(true);
        expect(JSON.stringify(fast.parsed)).toBe(JSON.stringify(exact));
        expect(Object.getPrototypeOf(fast.parsed)).toBe(Array.isArray(fast.parsed) ? Array.prototype : Object.prototype);
      } else refused += 1;
      const generic = encodeTurnValue(raw, files, 'rawOutput'), encoded = encodeTurnValue(raw, files, 'rawOutput', undefined, bodies);
      expect(encoded).toEqual(generic);
      expect(decodeTurnValue(encoded, files) === raw).toBe(true);
    }
  } } finally { uuid.next = undefined; }
  expect(shared).toBeGreaterThan(0);
  expect(refused).toBeGreaterThan(0);
  // A body that spells the token is cut out before the count, so it still takes the fast path.
  expect(tokenInBody).toBeGreaterThan(0);
});

it.each([
  ['a body used as a key', '{"BODY":"BODY"}', 'BODY'],
  ['a body literal that starts at an escaped quote inside a longer string', '["x\\"BODY"]', 'BODY'],
  ['a body split across two tokens', '["a","b"]', ','],
  ['a body straddling a key and its value', '{"a":"b"}', ':'],
  ['a body that is the whole raw text', '"BODY"', 'BODY'],
  ['a body whose literal is spelled with an escape', '{"x":"\\u0042ODY"}', 'BODY'],
  ['raw text that is not JSON', '"BODY" trailing', 'BODY'],
  ['a body that does not occur', '"BODY"', 'BOD'],
])('falls back to the full check for %s', (_, raw, body) => {
  expect(sharedJson(raw, [body])).toBeUndefined();
  expect(encodeTurnValue(raw, files, 'rawOutput', undefined, [body])).toEqual(encodeTurnValue(raw, files, 'rawOutput'));
});

it('restores every occurrence of a body and keeps an own "__proto__" key', () => {
  const body = 'line\n"quoted" 🙂 \ud800'.repeat(100), raw = `{"__proto__":${JSON.stringify(body)},"list":[${JSON.stringify(body)},1]}`;
  const fast = sharedJson(raw, [body])!;
  expect(Object.keys(fast.parsed)).toEqual(['__proto__', 'list']);
  expect(Object.getPrototypeOf(fast.parsed)).toBe(Object.prototype);
  expect(JSON.stringify(fast.parsed) === raw).toBe(true);
  const value = { outputText: body, rawOutput: raw };
  expect(sharedBodies(Object.values(value))).toEqual([body, raw]);
  expect(decodeTurnValue(encodeTurnValue(value, files), files)).toEqual(value);
});

it('falls back when the raw text already spells the placeholder it would use', () => {
  uuid.next = '00000000-0000-4000-8000-000000000000';
  try {
    const raw = JSON.stringify([`\u0000gugu-shared-body:${uuid.next}:0`, 'BODY']);
    expect(sharedJson(raw, ['BODY'])).toBeUndefined();
    expect(decodeTurnValue(encodeTurnValue(raw, files, 'rawOutput', undefined, ['BODY']), files) === raw).toBe(true);
  } finally { uuid.next = undefined; }
});

it('shares a body that spells the token itself: only the skeleton outside the cut bodies is counted', () => {
  uuid.next = '00000000-0000-4000-8000-000000000000';
  try {
    const body = `before ${uuid.next} \u0000gugu-shared-body:${uuid.next}:0 after `.repeat(30);
    const raw = JSON.stringify({ aggregatedOutput: body, exitCode: 0 }, null, 2), fast = sharedJson(raw, [body])!;
    expect(fast.indent).toBe(2);
    expect((fast.parsed as { aggregatedOutput: string }).aggregatedOutput === body).toBe(true);
    expect(JSON.stringify(fast.parsed, null, fast.indent) === raw).toBe(true);
    const encoded = encodeTurnValue(raw, files, 'rawOutput', undefined, [body]);
    expect(encoded).toEqual(encodeTurnValue(raw, files, 'rawOutput'));
    expect(decodeTurnValue(encoded, files) === raw).toBe(true);
  } finally { uuid.next = undefined; }
});

it.each([
  ['inside a longer string', (token: string) => JSON.stringify([`x${token}`, 'BODY'])],
  ['as a key', (token: string) => JSON.stringify({ [token]: 'BODY' })],
  ['as a placeholder of a slot that is not used', (token: string) => JSON.stringify([`\u0000gugu-shared-body:${token}:1`, 'BODY'])],
])('falls back when the skeleton spells the token once more than its placeholders: %s', (_, spell) => {
  uuid.next = '00000000-0000-4000-8000-000000000000';
  try {
    const raw = spell(uuid.next);
    expect(sharedJson(raw, ['BODY'])).toBeUndefined();
    expect(decodeTurnValue(encodeTurnValue(raw, files, 'rawOutput', undefined, ['BODY']), files) === raw).toBe(true);
  } finally { uuid.next = undefined; }
});

it('skips a body occurrence that overlaps one already cut and still restores the raw text exactly', () => {
  const raw = '["a","b"]', fast = sharedJson(raw, ['a', ','])!;
  expect(JSON.stringify(fast.parsed, null, fast.indent) === raw).toBe(true);
});
