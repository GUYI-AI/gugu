import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
import { CLAUDE_REVERT_MARK } from './claude-branches';
import { createClaudeJsonlSource } from './claude-jsonl';

/**
 * A real Claude CLI transcript (2.1.326, sanitized) where a refused prompt poisoned two turns, then
 * `--resume-session-at <the first answer>` stepped back and two more turns followed. The rewound turns stay in the file
 * as a branch; the conversation is the path to the newest line, so a reader must never hand the rewound turns back
 * (a backfill would re-insert them after the turn kept).
 */
const FIXTURE = fileURLToPath(new URL('../__fixtures__/claude-rewound-session.jsonl', import.meta.url));
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const disposers: Array<() => unknown> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

async function messages(fixture: string, sessionId: string, readMode?: 'snapshot'): Promise<Array<[string, string]>> {
  const root = await mkdtemp(join(tmpdir(), 'claude-rewound-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-workspace'), { recursive: true });
  await writeFile(join(root, '-workspace', `${sessionId}.jsonl`), await readFile(fixture, 'utf8'));
  const source: SessionRecordSource = createClaudeJsonlSource({ harness: 'claude', providerSessionId: sessionId, roots: [root] },
    { pollIntervalMs: 60_000, ...(readMode ? { readMode } : {}) });
  disposers.push(() => source.stop());
  const entries: RecordEntry[] = [];
  await source.start({ onEntries: (batch) => entries.push(...batch), onReset: () => {} });
  return entries.flatMap((entry) => entry.event?.kind === 'message' && typeof entry.event.text === 'string' && entry.event.text
    ? [[entry.event.role ?? '', entry.event.text] as [string, string]] : []);
}

const texts = async (readMode?: 'snapshot') => (await messages(FIXTURE, SESSION_ID, readMode))
  .flatMap(([role, text]) => role === 'user' ? [text] : []);

describe('claude record after a rewind', () => {
  for (const mode of [undefined, 'snapshot'] as const) {
    it(`reads only the path that continues (${mode ?? 'tail'})`, async () => {
      const prompts = await texts(mode);
      expect(prompts).toEqual(['hello', 'hello after rewind', 'and once more (plain resume)']);
    });
  }
});

/**
 * Real transcripts from claude-agent-acp 1.7.1 on Claude CLI 2.1.322 (sanitized: chain lines only, no attachment bodies,
 * no request blobs). Three turns, the second writes a file; then `_session/revert` back to before turn 2, which writes
 * the revert mark at the kept point. `noresend`: nothing sent after the revert; the bridge restarts and is asked what it
 * remembers. `resend`: a revert to before turn 3, then turn 4, restart, the same question.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../__fixtures__/claude-revert-${name}.jsonl`, import.meta.url));
const QUESTION = 'List every codeword I asked you to remember in this conversation, exactly, one per line, nothing else.';

describe('claude record after a revert through claude-agent-acp', () => {
  for (const mode of [undefined, 'snapshot'] as const) {
    it(`a revert with nothing sent after it already leaves the removed turns out (${mode ?? 'tail'})`, async () => {
      const read = await messages(fixture('noresend'), 'ea19b59f-0ab4-41be-93e6-d40c763f98c5', mode);
      expect(read.map(([role, text]) => [role, text.slice(0, 30)])).toEqual([
        ['user', 'Remember codeword #1: APPLE-17'], ['assistant', 'ok 1'],
        ['user', QUESTION.slice(0, 30)], ['assistant', 'APPLE-17'],
      ]);
    });

    it(`a revert followed by a new turn reads the kept turns and the new one, never the mark (${mode ?? 'tail'})`, async () => {
      const read = await messages(fixture('resend'), '44d63170-0ea0-4583-8e5b-a34215a5ecf8', mode);
      expect(read.filter(([role]) => role === 'user').map(([, text]) => text.slice(0, 30))).toEqual([
        'Remember codeword #1: APPLE-17', 'Remember codeword #2: BANANA-4', 'Remember codeword #4: DAMSON-5', QUESTION.slice(0, 30),
      ]);
      expect(read.some(([, text]) => text.includes('stepped back'))).toBe(false);
    });
  }

  it('the mark is the text the installed bridge writes', () => {
    const require = createRequire(import.meta.url);
    const bridge = readFileSync(join(dirname(require.resolve('@agentclientprotocol/claude-agent-acp')), 'acp-agent.js'), 'utf8');
    expect(bridge).toContain(`export const REVERT_MARK = ${JSON.stringify(CLAUDE_REVERT_MARK)};`);
  });
});
