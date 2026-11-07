/** Read only complete scalar tokens from a bounded, possibly unfinished JSON prefix.
 * In particular, session_meta's giant base_instructions need not finish first.
 */
export function transcriptPrefixMetadata(text: string, engine: 'claude-code' | 'codex') {
  const result: { providerSessionId?: string; cwd?: string } = {};
  const stack: Array<{ kind: string; key: string | null; expectingKey: boolean }> = [];
  const token = /\s+|"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let position = 0, rootType: string | null = null;
  while (position < text.length) {
    token.lastIndex = position;
    const match = token.exec(text);
    if (!match) break; // An unfinished string is retained by the source, never guessed.
    position = token.lastIndex;
    const value = match[0], top = stack.at(-1);
    if (!value.trim() || value === ':') continue;
    if (value === '{' || value === '[') {
      if (!stack.length) rootType = null;
      stack.push({ kind: value, key: null, expectingKey: value === '{' });
    } else if (value === '}' || value === ']') stack.pop();
    else if (value === ',') { if (top) { top.key = null; top.expectingKey = top.kind === '{'; } }
    else if (value.startsWith('"') && top) {
      const scalar = JSON.parse(value) as string;
      if (top.expectingKey) { top.key = scalar; top.expectingKey = false; continue; }
      if (stack.length === 1 && top.key === 'type') rootType = scalar;
      const metadata = engine === 'claude-code' ? stack.length === 1
        : stack.length === 2 && stack[0].key === 'payload' && top.kind === '{' && rootType === 'session_meta';
      if (metadata && scalar) {
        if (top.key === (engine === 'claude-code' ? 'sessionId' : 'id')) result.providerSessionId ??= scalar;
        if (top.key === 'cwd') result.cwd ??= scalar;
      }
    }
  }
  return result;
}
