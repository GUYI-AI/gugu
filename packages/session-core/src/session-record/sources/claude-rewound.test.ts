import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('tool and MCP lines Claude Code hangs under the mark before its synthetic answer stay with the mark', async () => {
    // The shape of a restart that wrote deltas first (Claude CLI, 11-19 probe): mark → attachment → attachment → synthetic.
    const id = '22222222-3333-4444-8555-666666666666';
    const line = (uuid: string, parentUuid: string | null, body: Record<string, unknown>) =>
      JSON.stringify({ parentUuid, isSidechain: false, uuid, sessionId: id, timestamp: '2026-11-19T10:00:00.000Z', ...body });
    const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
    const reply = (text: string, model = 'claude-opus-5-5') =>
      ({ type: 'assistant', message: { id: `m-${text}`, model, role: 'assistant', type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
    const attachment = (type: string) => ({ type: 'attachment', attachment: { type } });
    const root = await mkdtemp(join(tmpdir(), 'claude-revert-chain-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'chain.jsonl');
    await writeFile(file, [
      line('u1', null, user('one')), line('a1', 'u1', reply('ok 1')), line('x1', 'a1', attachment('prompt_snapshot')),
      line('u2', 'x1', user('two')), line('a2', 'u2', reply('ok 2')),
      line('m', 'a1', user(CLAUDE_REVERT_MARK)), line('t1', 'm', attachment('deferred_tools_delta')), line('t2', 't1', attachment('mcp_instructions_delta')),
      line('s', 't2', reply('No response requested.', '<synthetic>')), line('q', 's', user('what do you remember?')), line('r', 'q', reply('one')),
    ].join('\n') + '\n');
    expect(await messages(file, id)).toEqual([['user', 'one'], ['assistant', 'ok 1'], ['user', 'what do you remember?'], ['assistant', 'one']]);
  });

  it('the mark is the text the installed bridge writes', () => {
    // The package exports only an `import` entry, so find its file the way Node walks node_modules.
    let dir = dirname(fileURLToPath(import.meta.url)), entry = '';
    while (!entry) {
      const candidate = join(dir, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js');
      if (existsSync(candidate)) entry = candidate;
      else if (dirname(dir) === dir) throw new Error('claude-agent-acp is not installed');
      else dir = dirname(dir);
    }
    const bridge = readFileSync(entry, 'utf8');
    expect(bridge).toContain(`export const REVERT_MARK = ${JSON.stringify(CLAUDE_REVERT_MARK)};`);
  });
});
