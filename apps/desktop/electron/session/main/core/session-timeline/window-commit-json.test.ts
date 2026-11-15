import { describe, expect, it } from 'vitest';
import { createCommitJsonState, resumeCommitJsonState, scanCommitJson, type CommitJsonToken } from './window-commit-json';

function scan(raw: Uint8Array, width: number, origin = 0) {
  let state = createCommitJsonState(origin); const tokens: CommitJsonToken[] = [];
  while (state.offset - origin < raw.length) {
    const at = state.offset - origin, part = raw.subarray(at, Math.min(raw.length, at + width));
    const next = scanCommitJson(state, part, state.offset, at + part.length === raw.length);
    expect(next.length).toBeLessThanOrEqual(32); tokens.push(...next);
    state = resumeCommitJsonState(JSON.parse(JSON.stringify(state)));
  }
  if (state.mode === 'primitive') tokens.push(...scanCommitJson(state, new Uint8Array(0), state.offset, true));
  return { tokens, state };
}
describe('bounded canonical JSON lexical positions', () => {
  it('resumes every byte boundary including escapes and nonzero offsets beyond two GiB', () => {
    const raw = Buffer.from('{"id":"row","text":"中文😀\\n\\uD83D\\uDE00\\"end","empty":"","seq":123,"done":true,"none":null}');
    const origin = 5 * 1024 ** 3;
    for (const width of [1, 2, 7, 16384]) {
      const { tokens, state } = scan(raw, width, origin);
      const strings = tokens.filter((token): token is Extract<CommitJsonToken, { kind: 'string' }> => token.kind === 'string');
      expect(strings.map(token => raw.subarray(token.start - origin, token.end - origin).toString())).toEqual([
        'id', 'row', 'text', '中文😀\\n\\uD83D\\uDE00\\"end', 'empty', '', 'seq', 'done', 'none',
      ]);
      expect(strings[3].escaped).toBe(true); expect(strings[5].start).toBe(strings[5].end);
      expect(tokens.filter(token => token.kind === 'primitive').map(token => token.value)).toEqual([123, true, null]);
      expect(state.offset).toBe(origin + raw.length); expect(state.mode).toBe('base');
    }
  });

  it('streams a giant string with a constant checkpoint and emits only its source range', () => {
    const state = createCommitJsonState(); const tokens = scanCommitJson(state, Buffer.from('"'), 0);
    const block = Buffer.alloc(16384, 97);
    for (let n = 0; n < 256; n++) {
      tokens.push(...scanCommitJson(state, block, state.offset));
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(200); expect(state.primitive).toBe('');
    }
    tokens.push(...scanCommitJson(state, Buffer.from('"'), state.offset, true));
    expect(tokens).toEqual([{ kind: 'string', start: 1, end: 1 + 256 * 16384, escaped: false }]);
  });

  it('stops within a physical frame when its fixed token page is full and resumes without dropping punctuation', () => {
    const raw = Buffer.from('[' + Array.from({ length: 200 }, (_, n) => String(n)).join(',') + ']');
    const { tokens, state } = scan(raw, 16384);
    expect(tokens.filter(token => token.kind === 'primitive').map(token => token.value)).toEqual(Array.from({ length: 200 }, (_, n) => n));
    expect(tokens.filter(token => token.kind === 'punctuation' && token.value === ',')).toHaveLength(199);
    expect(state.offset).toBe(raw.length);
  });

  it.each(['"bad\\x"', '"bad\\u00Q0"', '"line\nfeed"', '"unfinished', '"slash\\', '01', '1e', '1e999', 'tru'])('rejects invalid lexical input %j', value => {
    expect(() => scan(Buffer.from(value), 1)).toThrow();
  });

  it('rejects incompatible or malformed checkpoints, shifted offsets and oversized input before scanning', () => {
    const valid = createCommitJsonState(3000);
    for (const broken of [{ ...valid, version: 2 }, { ...valid, offset: -1 }, { ...valid, start: 3001 },
      { ...valid, mode: 'unicode' }, { ...valid, primitive: 'x' }, { ...valid, mode: 'primitive', primitive: 'x'.repeat(129) }])
      expect(() => resumeCommitJsonState(broken)).toThrow(/checkpoint/);
    expect(() => scanCommitJson(valid, Buffer.from('null'), 0)).toThrow(/range/);
    expect(() => scanCommitJson(valid, Buffer.alloc(16385), 3000)).toThrow(/range/);
    expect(valid.offset).toBe(3000);
  });
});
