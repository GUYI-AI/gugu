import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
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

async function texts(readMode?: 'snapshot'): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'claude-rewound-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-workspace'), { recursive: true });
  await writeFile(join(root, '-workspace', `${SESSION_ID}.jsonl`), await readFile(FIXTURE, 'utf8'));
  const source: SessionRecordSource = createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] },
    { pollIntervalMs: 60_000, ...(readMode ? { readMode } : {}) });
  disposers.push(() => source.stop());
  const entries: RecordEntry[] = [];
  await source.start({ onEntries: (batch) => entries.push(...batch), onReset: () => {} });
  return entries.flatMap((entry) => entry.event?.kind === 'message' && entry.event.role === 'user' && typeof entry.event.text === 'string'
    ? [entry.event.text] : []);
}

describe('claude record after a rewind', () => {
  for (const mode of [undefined, 'snapshot'] as const) {
    it(`reads only the path that continues (${mode ?? 'tail'})`, async () => {
      const prompts = await texts(mode);
      expect(prompts).toEqual(['hello', 'hello after rewind', 'and once more (plain resume)']);
    });
  }
});
