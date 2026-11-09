/** Lexical source positions only. Structural/schema validation and exact owner
 * slots belong to the projection builder; no string payload is accumulated. */
export type CommitJsonState = {
  version: 1; offset: number; start: number; mode: 'base' | 'string' | 'escape' | 'unicode' | 'primitive';
  unicodeLeft: number; escaped: boolean; primitive: string;
};
export type CommitJsonToken = { kind: 'string'; start: number; end: number; escaped: boolean }
  | { kind: 'primitive'; start: number; end: number; value: number | boolean | null }
  | { kind: 'punctuation'; start: number; end: number; value: '{' | '}' | '[' | ']' | ':' | ',' };
const punctuation: Record<number, '{' | '}' | '[' | ']' | ':' | ','> = { 123: '{', 125: '}', 91: '[', 93: ']', 58: ':', 44: ',' };
const white = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const position = (value: number) => Number.isSafeInteger(value) && value >= 0;
const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function primitive(raw: string): number | boolean | null {
  if (raw === 'null') return null;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (!number.test(raw) || !Number.isFinite(Number(raw))) throw new SyntaxError('Invalid canonical JSON primitive');
  return Number(raw);
}
export function createCommitJsonState(offset = 0): CommitJsonState {
  if (!position(offset)) throw new RangeError('Invalid canonical JSON origin');
  return { version: 1, offset, start: offset, mode: 'base', unicodeLeft: 0, escaped: false, primitive: '' };
}
/** Only a bounded derived checkpoint is accepted; the caller can rebuild a bad
 * checkpoint at the receipt's raw row anchor, never by parsing a canonical row. */
export function resumeCommitJsonState(input: unknown): CommitJsonState {
  const value = input as CommitJsonState;
  if (!value || value.version !== 1 || !position(value.offset) || !position(value.start) || value.start > value.offset
    || !['base', 'string', 'escape', 'unicode', 'primitive'].includes(value.mode) || typeof value.escaped !== 'boolean'
    || !Number.isSafeInteger(value.unicodeLeft) || value.unicodeLeft < 0 || value.unicodeLeft > 4
    || (value.mode === 'unicode') !== (value.unicodeLeft > 0) || typeof value.primitive !== 'string' || value.primitive.length > 128
    || value.mode !== 'primitive' && value.primitive !== '') throw new Error('Invalid canonical JSON checkpoint');
  return { version: 1, offset: value.offset, start: value.start, mode: value.mode,
    unicodeLeft: value.unicodeLeft, escaped: value.escaped, primitive: value.primitive };
}

/** One <=16KiB input and at most 32 small tokens per step. A giant string may
 * cross any number of calls while its checkpoint remains constant size. The
 * returned offset can stop inside this physical source frame. */
export function scanCommitJson(state: CommitJsonState, bytes: Uint8Array, start: number, eof = false): CommitJsonToken[] {
  if (start !== state.offset || bytes.length > 16384 || !position(start + bytes.length)) throw new RangeError('Invalid canonical JSON scan range');
  const tokens: CommitJsonToken[] = [];
  let at = 0;
  const finishPrimitive = () => {
    tokens.push({ kind: 'primitive', start: state.start, end: state.offset, value: primitive(state.primitive) });
    state.mode = 'base'; state.primitive = '';
  };
  while (at < bytes.length && tokens.length < 32) {
    const byte = bytes[at], offset = start + at;
    if (state.mode === 'primitive') {
      if (white(byte) || punctuation[byte]) { finishPrimitive(); continue; }
      if (state.primitive.length >= 128) throw new SyntaxError('Invalid canonical JSON primitive length');
      state.primitive += String.fromCharCode(byte);
    } else if (state.mode === 'unicode') {
      if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) throw new SyntaxError('Invalid JSON Unicode escape');
      if (--state.unicodeLeft === 0) state.mode = 'string';
    } else if (state.mode === 'escape') {
      if (byte === 117) { state.mode = 'unicode'; state.unicodeLeft = 4; }
      else if ([34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) state.mode = 'string';
      else throw new SyntaxError('Invalid JSON string escape');
    } else if (state.mode === 'string') {
      if (byte === 34) { tokens.push({ kind: 'string', start: state.start, end: offset, escaped: state.escaped }); state.mode = 'base'; }
      else if (byte === 92) { state.mode = 'escape'; state.escaped = true; }
      else if (byte < 32) throw new SyntaxError('Unescaped JSON string control character');
    } else if (byte === 34) { state.mode = 'string'; state.start = offset + 1; state.escaped = false; }
    else if (punctuation[byte]) tokens.push({ kind: 'punctuation', start: offset, end: offset + 1, value: punctuation[byte] });
    else if (!white(byte)) { state.mode = 'primitive'; state.start = offset; state.primitive = String.fromCharCode(byte); }
    state.offset = start + ++at;
  }
  if (eof && at === bytes.length && tokens.length < 32) {
    if (state.mode === 'primitive') finishPrimitive();
    if (state.mode !== 'base') throw new SyntaxError('Incomplete canonical JSON token');
  }
  return tokens;
}
