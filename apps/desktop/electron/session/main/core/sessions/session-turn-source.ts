import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { TurnPayloadFiles, type TurnPayloadRef } from './session-turn-payloads';
import type { StoredTurnValue } from './session-turn-codec';

/** A virtual JSON byte stream. Bodies are the canonical payload objects, never copied into a window source. */
export type TurnJsonRef = { ref: TurnPayloadRef; bytes: number };
type Leaf = { kind: 'literal'; ref: TurnPayloadRef } | { kind: 'inline'; text: string }
  | { kind: 'text'; ref: TurnPayloadRef; start: number; end: number; escape: number }
  | { kind: 'image'; ref: TurnPayloadRef; start: number; end: number };
type Piece = Leaf | { kind: 'concat'; parts: TurnJsonRef[] }
  | { kind: 'page'; parts: Array<{ piece: Leaf; bytes: number }> };
type Fragment = string | Exclude<Leaf, { kind: 'literal' | 'inline' }>;
type Part = { piece: Leaf; bytes: number };
/**
 * A literal run up to this stored descriptor size rides in its page instead of becoming its own object: the keys and
 * punctuation between two bodies usually fit. A longer run stays an object. Two runs side by side cannot both be short
 * (the first ended because the second would have overflowed 2 KiB), so a page still covers many output bytes for every
 * index byte it costs.
 */
const INLINE_RUN_BYTES = 512;
const escape = (text: string, layers: number) => {
  for (let at = 0; at < layers; at++) text = JSON.stringify(text).slice(1, -1);
  return text;
};

/**
 * Quotes and backslashes are the only bytes another JSON layer expands. A native search wins on sparse text, but dense text
 * (quoted output, nested JSON) would return to JS once per hit, so past a few hits count four bytes per step instead.
 */
export function jsonSpecialBytes(input: Uint8Array): number {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let count = 0;
  for (const byte of [34, 92]) for (let at = bytes.indexOf(byte); at !== -1; at = bytes.indexOf(byte, at + 1)) if (++count > 16) return denseSpecialBytes(input);
  return count;
}

function denseSpecialBytes(bytes: Uint8Array): number {
  const special = (byte: number) => byte === 34 || byte === 92;
  let count = 0, at = 0;
  const head = (4 - (bytes.byteOffset & 3)) & 3;
  if (bytes.length - head >= 4) {
    for (; at < head; at++) if (special(bytes[at])) count++;
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset + at, (bytes.length - at) >>> 2);
    // An indexed loop: for-of over a typed array ran this scan at half the speed.
    for (let index = 0; index < words.length; index++) {
      // An exact per-byte equality test, with no borrow between bytes: a byte keeps its high bit only where it matched.
      const word = words[index], quote = word ^ 0x22222222, slash = word ^ 0x5c5c5c5c;
      const hits = (~(((quote & 0x7f7f7f7f) + 0x7f7f7f7f) | quote | 0x7f7f7f7f) >>> 7)
        + (~(((slash & 0x7f7f7f7f) + 0x7f7f7f7f) | slash | 0x7f7f7f7f) >>> 7);
      count += Math.imul(hits, 0x01010101) >>> 24;
    }
    at += words.length * 4;
  }
  for (; at < bytes.length; at++) if (special(bytes[at])) count++;
  return count;
}

/** The leaf is already JSON encoded: further layers expand only quotes and backslashes. */
function escapedText(input: Uint8Array, layers: number, range?: { start: number; end: number }): { bytes: number; value?: Buffer } {
  const expansion = 2 ** layers;
  if (!Number.isSafeInteger(layers) || layers < 0 || !Number.isSafeInteger(expansion)) throw new Error('Invalid canonical JSON escape');
  if (!layers) {
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end > input.byteLength)) throw new Error('Invalid escaped text range');
    return { bytes: input.byteLength, value: range ? Buffer.from(input.subarray(range.start, range.end)) : undefined };
  }
  if (!range) {
    // Source construction needs the length, not the expanded body.
    const length = input.byteLength + jsonSpecialBytes(input) * (expansion - 1);
    if (!Number.isSafeInteger(length)) throw new Error('Canonical JSON length exceeds addressable bytes');
    return { bytes: length };
  }
  const output = range ? Buffer.alloc(range.end - range.start) : undefined;
  let offset = 0, written = 0;
  for (const byte of input) {
    const special = byte === 34 || byte === 92, width = special ? expansion : 1;
    if (output && range) {
      const start = Math.max(offset, range.start), end = Math.min(offset + width, range.end);
      if (end > start) {
        output.fill(special ? 92 : byte, written, written + end - start);
        if (byte === 34 && end === offset + width) output[written + end - start - 1] = 34;
        written += end - start;
      }
    }
    offset += width;
    if (!Number.isSafeInteger(offset)) throw new Error('Canonical JSON length exceeds addressable bytes');
  }
  if (range && (range.start < 0 || range.end > offset || written !== output!.length)) throw new Error('Invalid escaped text range');
  return { bytes: offset, value: output };
}

export function createTurnJsonSource(files: TurnPayloadFiles, value: StoredTurnValue): TurnJsonRef {
  const node = (piece: Piece, bytes: number): TurnJsonRef => ({ ref: files.putText(JSON.stringify(piece),
    piece.kind === 'concat' ? piece.parts.map(part => part.ref)
      : piece.kind === 'page' ? piece.parts.flatMap(part => part.piece.kind === 'inline' ? [] : [part.piece.ref])
        : piece.kind === 'inline' ? [] : [piece.ref]), bytes });
  function* render(input: StoredTurnValue, indent = 0, depth = 0, layers = 0): Generator<Fragment> {
    const literal = (text: string) => escape(text, layers);
    switch (input.t) {
      case 'value': yield literal(JSON.stringify(input.value)); return;
      case 'node': yield* render(JSON.parse(files.readText(input.ref)) as StoredTurnValue, indent, depth, layers); return;
      case 'text':
        yield literal('"');
        // These are virtual ranges in one payload, not independent physical files.
        for (let at = 1; at < input.ref.bytes - 1; at += 12 * 1024) yield {
          kind: 'text', ref: input.ref, start: at, end: Math.min(input.ref.bytes - 1, at + 12 * 1024), escape: layers,
        };
        yield literal('"'); return;
      case 'base64':
        yield literal('"');
        for (let at = 0; at < input.ref.bytes; at += 12 * 1024) yield { kind: 'image', ref: input.ref, start: at, end: Math.min(input.ref.bytes, at + 12 * 1024) };
        yield literal('"'); return;
      case 'json':
        yield literal('"'); yield* render(input.value, input.indent, 0, layers + 1); yield literal('"'); return;
      case 'array':
      case 'object': {
        const object = input.t === 'object', entries: Array<[string | null, StoredTurnValue]> = object ? input.values : input.values.map(one => [null, one]);
        yield literal(object ? '{' : '[');
        for (let at = 0; at < entries.length; at++) {
          if (at) yield literal(',');
          if (indent) yield literal('\n' + ' '.repeat(indent * (depth + 1)));
          const [key, child] = entries[at];
          if (key !== null) yield literal(JSON.stringify(key) + (indent ? ': ' : ':'));
          yield* render(child, indent, depth + 1, layers);
        }
        if (entries.length && indent) yield literal('\n' + ' '.repeat(indent * depth));
        yield literal(object ? '}' : ']'); return;
      }
      default: throw new Error('Unknown stored turn source value');
    }
  }
  const parts: TurnJsonRef[] = [];
  let page: Part[] = [], pageBytes = 40;
  const flushPage = () => {
    if (page.length) parts.push(node({ kind: 'page', parts: page }, page.reduce((sum, part) => sum + part.bytes, 0)));
    page = []; pageBytes = 40;
  };
  // The page is stored as a JSON text payload, so a descriptor costs its serialization quoted once more, plus a comma.
  const stored = (part: Part) => Buffer.byteLength(JSON.stringify(JSON.stringify(part))) + 1;
  const add = (part: Part, size = stored(part)) => {
    // Pages only contain bounded descriptors. Bodies keep their separate source-I/O accounting.
    if (page.length === 32 || pageBytes + size > 8192) flushPage();
    page.push(part); pageBytes += size;
  };
  let text = '', textBytes = 0;
  const flush = () => {
    if (!text) return;
    const inline: Part = { piece: { kind: 'inline', text }, bytes: textBytes }, size = stored(inline);
    if (size <= INLINE_RUN_BYTES) add(inline, size);
    else add({ piece: { kind: 'literal', ref: files.putBytes(Buffer.from(text)) }, bytes: textBytes });
    text = ''; textBytes = 0;
  };
  for (const fragment of render(value)) {
    if (typeof fragment === 'string') {
      const length = Buffer.byteLength(fragment);
      if (length <= 2048) {
        if (textBytes + length > 2048) flush();
        text += fragment; textBytes += length;
        continue;
      }
      for (const character of fragment) {
        text += character; textBytes += Buffer.byteLength(character);
        if (textBytes >= 2048) flush();
      }
    } else {
      flush();
      const bytes = fragment.kind === 'image' ? 4 * Math.ceil((fragment.end - fragment.start) / 3)
        : !fragment.escape ? fragment.end - fragment.start
          : escapedText(files.readEncodedTextRange(fragment.ref, fragment.start, fragment.end), fragment.escape).bytes;
      add({ piece: fragment, bytes });
    }
  }
  flush();
  flushPage();
  let level = parts;
  if (!level.length) throw new Error('Empty canonical turn JSON');
  while (level.length > 1) {
    const next: TurnJsonRef[] = [];
    for (let at = 0; at < level.length; at += 32) {
      const children = level.slice(at, at + 32);
      next.push(node({ kind: 'concat', parts: children }, children.reduce((sum, part) => sum + part.bytes, 0)));
    }
    level = next;
  }
  return level[0];
}

/** Same exact stream for old and new window readers; only its physical storage has changed. */
export function readTurnJsonRange(directory: string, root: TurnJsonRef, start: number, end: number, budget: WindowBudget): Uint8Array {
  let io: 'sourceBytes' | 'indexBytes' = 'indexBytes';
  const files = new TurnPayloadFiles(directory, (requested, read, metadata) => budget.readSync(metadata ? 'indexBytes' : io, requested, read));
  const cache = new Map<string, Piece>();
  // CAS bodies are canonical source I/O; descriptors remain index I/O. Keep both existing ceilings.
  const withBody = <T>(read: () => T): T => { const before = io; io = 'sourceBytes'; try { return read(); } finally { io = before; } };
  const valid = (ref: TurnJsonRef) => ref && /^[a-f0-9]{64}$/.test(ref.ref?.hash) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0;
  function read(ref: TurnJsonRef, from: number, to: number, lineage: ReadonlySet<string>): Buffer {
    if (!valid(ref) || from < 0 || to < from || to > ref.bytes || lineage.has(ref.ref.hash)) throw new Error('Invalid canonical JSON range');
    let piece = cache.get(ref.ref.hash);
    if (!piece) { piece = JSON.parse(files.readText(ref.ref)) as Piece; if (cache.size < 64) cache.set(ref.ref.hash, piece); }
    if (piece.kind === 'concat') {
      if (!Array.isArray(piece.parts) || piece.parts.length < 1 || piece.parts.length > 32
        || piece.parts.some(part => !valid(part)) || piece.parts.reduce((n, part) => n + part.bytes, 0) !== ref.bytes) throw new Error('Invalid canonical JSON branch');
      const nextLineage = new Set(lineage).add(ref.ref.hash), parts: Buffer[] = [];
      let at = 0;
      for (const child of piece.parts) {
        const next = at + child.bytes;
        if (next > from && at < to) parts.push(read(child, Math.max(0, from - at), Math.min(child.bytes, to - at), nextLineage));
        at = next;
      }
      return Buffer.concat(parts, to - from);
    }
    if (piece.kind === 'page') {
      if (!Array.isArray(piece.parts) || piece.parts.length < 1 || piece.parts.length > 32
        || piece.parts.some(part => !part.piece || !['literal', 'inline', 'text', 'image'].includes(part.piece.kind)
          || !Number.isSafeInteger(part.bytes) || part.bytes < 0)
        || piece.parts.reduce((sum, part) => sum + part.bytes, 0) !== ref.bytes) throw new Error('Invalid canonical JSON page');
      let at = 0;
      const parts: Buffer[] = [];
      for (const part of piece.parts) {
        const next = at + part.bytes;
        if (next > from && at < to) parts.push(readLeaf(part.piece, part.bytes, Math.max(0, from - at), Math.min(part.bytes, to - at)));
        at = next;
      }
      return Buffer.concat(parts, to - from);
    }
    return readLeaf(piece, ref.bytes, from, to);
  }
  function readLeaf(piece: Leaf, length: number, from: number, to: number): Buffer {
    let bytes: Buffer;
    if (piece.kind === 'literal') {
      if (piece.ref.bytes !== length) throw new Error('Canonical JSON literal length mismatch');
      return withBody(() => files.readBytesRange(piece.ref, from, to));
    } else if (piece.kind === 'inline') {
      if (typeof piece.text !== 'string') throw new Error('Invalid canonical inline literal');
      // Read with its page as index I/O, and admitted again as source bytes: the source ceiling still bounds the
      // content a request returns, as it did when every run was an object of its own.
      const text = piece.text, decoded: { bytes?: Buffer } = {};
      budget.readSync('sourceBytes', length, () => (decoded.bytes = Buffer.from(text)).length);
      bytes = decoded.bytes!;
    } else if (piece.kind === 'text') {
      if (!Number.isSafeInteger(piece.start) || !Number.isSafeInteger(piece.end) || piece.start < 1
        || piece.end < piece.start || piece.end - piece.start > 12 * 1024 || piece.end >= piece.ref.bytes) throw new Error('Invalid canonical text range');
      const result = withBody(() => escapedText(files.readEncodedTextRange(piece.ref, piece.start, piece.end), piece.escape, { start: from, end: to }));
      if (result.bytes !== length) throw new Error('Canonical JSON text length mismatch');
      return result.value!;
    } else if (piece.kind === 'image') {
      if (!Number.isSafeInteger(piece.start) || !Number.isSafeInteger(piece.end) || piece.start % (12 * 1024) !== 0
        || piece.end < piece.start || piece.end - piece.start > 12 * 1024) throw new Error('Invalid canonical image range');
      bytes = withBody(() => Buffer.from(files.readBytesRange(piece.ref, piece.start, piece.end).toString('base64')));
    } else throw new Error('Unknown canonical JSON source node');
    if (bytes.length !== length) throw new Error('Canonical JSON source length mismatch');
    return bytes.subarray(from, to);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('Invalid canonical JSON offsets');
  return read(root, start, end, new Set());
}
