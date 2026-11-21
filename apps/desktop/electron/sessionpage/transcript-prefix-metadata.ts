import type { TranscriptSource } from '@gugu/core';

type Frame = { kind: '{' | '['; path: string[]; key: string; state: 'key' | 'keyOrEnd' | 'colon' | 'value' | 'valueOrEnd' | 'comma' };

function nextToken(text: string, start: number): { token: string; end: number } | 'partial' | null {
  const first = text[start]!;
  if ('{}[]:,'.includes(first)) return { token: first, end: start + 1 };
  if (first === '"') {
    for (let at = start + 1; at < text.length; at++) {
      const char = text[at]!;
      if (char === '"') return { token: text.slice(start, at + 1), end: at + 1 };
      if (char.charCodeAt(0) < 32) return null;
      if (char !== '\\') continue;
      const escape = text[++at];
      if (escape === undefined) return 'partial';
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u') return null;
      for (let count = 0; count < 4; count++) {
        const digit = text[++at];
        if (digit === undefined) return 'partial';
        if (!/[\da-fA-F]/.test(digit)) return null;
      }
    }
    return 'partial';
  }
  const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(start));
  return primitive ? { token: primitive[0], end: start + primitive[0].length } : null;
}

/** Metadata scalars before an unfinished body; never search body text for field names. */
export function transcriptPrefixMetadata(text: string, engine: TranscriptSource) {
  const fields = new Map<string, string>();
  const stack: Frame[] = [];
  let position = 0, rootEnded = false;
  const invalid = () => ({});
  while (position < text.length) {
    if (' \t\r\n'.includes(text[position]!)) { position++; continue; }
    const read = nextToken(text, position);
    // A valid unfinished string/value is not a completed scalar. All earlier
    // scalars remain useful; malformed syntax before it is rejected below.
    if (read === 'partial') {
      const state = stack.at(-1)?.state;
      if (state === 'comma' || state === 'colon') return invalid();
      break;
    }
    if (!read) return invalid();
    position = read.end;
    const token = read.token;
    if (rootEnded) return invalid();
    const top = stack.at(-1);
    if (top?.state === 'colon') {
      if (token !== ':') return invalid();
      top.state = 'value'; continue;
    }
    if (top?.state === 'comma') {
      if (token === ',') { top.state = top.kind === '{' ? 'key' : 'value'; continue; }
      if (token !== (top.kind === '{' ? '}' : ']')) return invalid();
    }
    if (token === '}' || token === ']') {
      if (!top || token !== (top.kind === '{' ? '}' : ']') || !['comma', 'keyOrEnd', 'valueOrEnd'].includes(top.state)) return invalid();
      stack.pop();
      if (!stack.length) rootEnded = true;
      continue;
    }
    if (top && (top.state === 'key' || top.state === 'keyOrEnd')) {
      if (!token.startsWith('"')) return invalid();
      top.key = JSON.parse(token) as string; top.state = 'colon'; continue;
    }
    if (top && top.state !== 'value' && top.state !== 'valueOrEnd') return invalid();
    const path = top ? [...top.path, top.kind === '{' ? top.key : '*'] : [];
    if (top) top.state = 'comma';
    if (token === '{' || token === '[') {
      if (stack.length >= 64) return invalid();
      stack.push({ kind: token, path, key: '', state: token === '{' ? 'keyOrEnd' : 'valueOrEnd' });
    } else {
      if (!top) return invalid();
      if (token.startsWith('"') && (path.length === 1 && ['type', 'sessionId', 'cwd'].includes(path[0]!)
        || path.length === 2 && path[0] === 'payload' && ['id', 'cwd'].includes(path[1]!))) {
        const key = path.join('.');
        if (['type', 'sessionId', 'cwd', 'payload.id', 'payload.cwd'].includes(key)) fields.set(key, JSON.parse(token) as string);
      }
    }
  }
  const id = engine === 'claude-code' ? fields.get('sessionId') : fields.get('type') === 'session_meta' ? fields.get('payload.id') : undefined;
  const cwd = engine === 'claude-code' ? fields.get('cwd') : fields.get('type') === 'session_meta' ? fields.get('payload.cwd') : undefined;
  return { ...(id ? { providerSessionId: id } : {}), ...(cwd ? { cwd } : {}) };
}
