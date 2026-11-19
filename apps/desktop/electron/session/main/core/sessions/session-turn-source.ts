import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { TurnPayloadFiles, type TurnPayloadRef } from './session-turn-payloads';
import type { StoredTurnValue } from './session-turn-codec';

/** A virtual JSON byte stream. Bodies are the canonical payload objects, never copied into a window source. */
export type TurnJsonRef = { ref: TurnPayloadRef; bytes: number };
type Piece = { kind: 'literal'; ref: TurnPayloadRef }
  | { kind: 'text'; ref: TurnPayloadRef; escape: number }
  | { kind: 'image'; ref: TurnPayloadRef; start: number; end: number }
  | { kind: 'concat'; parts: TurnJsonRef[] };
type Fragment = string | Exclude<Piece, { kind: 'literal' | 'concat' }>;
const escape = (text: string, layers: number) => {
  for (let at = 0; at < layers; at++) text = JSON.stringify(text).slice(1, -1);
  return text;
};

/** The leaf is already JSON encoded: further layers expand only quotes and backslashes. */
function escapedLeaf(encoded: string, layers: number, range?: { start: number; end: number }): { bytes: number; value?: Buffer } {
  const expansion = 2 ** layers;
  if (!Number.isSafeInteger(layers) || layers < 0 || !Number.isSafeInteger(expansion)) throw new Error('Invalid canonical JSON escape');
  const input = Buffer.from(encoded.slice(1, -1)), output = range ? Buffer.alloc(range.end - range.start) : undefined;
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
    piece.kind === 'concat' ? piece.parts.map(part => part.ref) : [piece.ref]), bytes });
  function* render(input: StoredTurnValue, indent = 0, depth = 0, layers = 0): Generator<Fragment> {
    const literal = (text: string) => escape(text, layers);
    switch (input.t) {
      case 'value': yield literal(JSON.stringify(input.value)); return;
      case 'node': yield* render(JSON.parse(files.readText(input.ref)) as StoredTurnValue, indent, depth, layers); return;
      case 'text':
        yield literal('"');
        if (input.ref.bytes) for (const ref of files.leafReferences(input.ref)) yield { kind: 'text', ref, escape: layers };
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
  let text = '', textBytes = 0;
  const flush = () => {
    if (text) { parts.push(node({ kind: 'literal', ref: files.putBytes(Buffer.from(text)) }, textBytes)); text = ''; textBytes = 0; }
  };
  for (const fragment of render(value)) {
    if (typeof fragment === 'string') {
      for (const character of fragment) {
        text += character; textBytes += Buffer.byteLength(character);
        if (textBytes >= 2048) flush();
      }
    } else {
      flush();
      const bytes = fragment.kind === 'image' ? 4 * Math.ceil((fragment.end - fragment.start) / 3)
        : escapedLeaf(files.encodedTextLeaf(fragment.ref), fragment.escape).bytes;
      parts.push(node(fragment, bytes));
    }
  }
  flush();
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
  const files = new TurnPayloadFiles(directory, bytes => budget.charge(io, bytes));
  const cache = new Map<string, Piece>();
  const withBody = <T>(read: () => T): T => { const before = io; io = 'sourceBytes'; try { return read(); } finally { io = before; } };
  const valid = (ref: TurnJsonRef) => ref && /^[a-f0-9]{64}$/.test(ref.ref?.hash) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0;
  function read(ref: TurnJsonRef, from: number, to: number, lineage: ReadonlySet<string>): Buffer {
    if (!valid(ref) || from < 0 || to < from || to > ref.bytes || lineage.has(ref.ref.hash)) throw new Error('Invalid canonical JSON range');
    let piece = cache.get(ref.ref.hash);
    if (!piece) { piece = JSON.parse(files.readText(ref.ref)) as Piece; if (cache.size < 64) cache.set(ref.ref.hash, piece); }
    let bytes: Buffer;
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
    if (piece.kind === 'literal') {
      if (piece.ref.bytes !== ref.bytes) throw new Error('Canonical JSON literal length mismatch');
      return withBody(() => files.readBytesRange(piece.ref, from, to));
    }
    else if (piece.kind === 'text') {
      const result = withBody(() => escapedLeaf(files.encodedTextLeaf(piece.ref), piece.escape, { start: from, end: to }));
      if (result.bytes !== ref.bytes) throw new Error('Canonical JSON text length mismatch');
      return result.value!;
    } else if (piece.kind === 'image') {
      if (!Number.isSafeInteger(piece.start) || !Number.isSafeInteger(piece.end) || piece.start % (12 * 1024) !== 0
        || piece.end < piece.start || piece.end - piece.start > 12 * 1024) throw new Error('Invalid canonical image range');
      bytes = withBody(() => Buffer.from(files.readBytesRange(piece.ref, piece.start, piece.end).toString('base64')));
    } else throw new Error('Unknown canonical JSON source node');
    if (bytes.length !== ref.bytes) throw new Error('Canonical JSON source length mismatch');
    return bytes.subarray(from, to);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('Invalid canonical JSON offsets');
  return read(root, start, end, new Set());
}
