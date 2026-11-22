import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import type { SessionRecordLocator } from '../contract';
import { createSessionRecordSource, createSessionTimeline } from '../index';

/**
 * A prompt read from the record carries the point its harness's revert steps back to, as its live receipt did
 * (`_meta.guguRevert`): the revert offered on a committed turn, and the cut a revert makes, both read it from the timeline.
 */

const disposers: Array<() => unknown> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

async function prompts(harness: SessionRecordLocator['harness'], name: string, id: string, layout: (root: string) => string, rows?: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'revert-points-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const file = layout(root);
  await mkdir(dirname(file), { recursive: true });
  if (rows) await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  else await copyFile(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), file);
  const timeline = await createSessionTimeline(createSessionRecordSource({ harness, providerSessionId: id, roots: [root] }), { sessionId: 's' });
  disposers.push(() => timeline.dispose());
  return timeline.getSnapshot({ limit: 1e9 }).turns.map((turn) => {
    const prompt = turn.items.find((item) => item.kind === 'message' && item.role === 'user');
    return { turn: turn.id.slice('s:'.length), ...(prompt?.kind === 'message' ? { anchor: prompt.revertAnchor, files: prompt.revertFiles } : {}) };
  });
}

it('Claude: a prompt reverts to before its own uuid, files included; the first prompt has nothing before it', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const [first, ...later] = await prompts('claude', 'claude-rewound-session.jsonl', id, (root) => join(root, 'project', `${id}.jsonl`));
  expect(first).toEqual({ turn: 'c9151008-0482-4342-9684-7a5276584a2d', anchor: undefined, files: undefined });
  expect(later.length).toBeGreaterThan(0);
  for (const turn of later) expect(turn).toEqual({ turn: turn.turn, anchor: turn.turn, files: true });
});

it('Codex: a turn reverts by the id its task_started line gives', async () => {
  const id = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
  const turns = await prompts('codex', 'codex-rollout.jsonl', id, (root) => join(root, '2026', '06', '18', `rollout-2026-06-18T07-03-21-${id}.jsonl`));
  expect(turns.map(({ anchor, files }) => ({ anchor, files }))).toEqual([{ anchor: '019ed98e-af45-79b0-b75f-4788f1027283', files: undefined }]);
});

it('CodeBuddy: a prompt rolls back to its own record id', async () => {
  const id = '01a1a66e-6f8b-7bb3-be21-e560e268a934';
  const turns = await prompts('codebuddy', 'codebuddy-session.jsonl', id, (root) => join(root, 'proj', `${id}.jsonl`));
  const fixture = (await readFile(fileURLToPath(new URL('../__fixtures__/codebuddy-session.jsonl', import.meta.url)), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { id: string; type: string; role?: string });
  const ids = fixture.filter((row) => row.type === 'message' && row.role === 'user').map((row) => row.id);
  expect(turns.map(({ anchor, files }) => ({ anchor, files }))).toEqual(ids.map((anchor) => ({ anchor, files: undefined })));
});

it('Qwen: a prompt rewinds by the promptId its lines carry, files included; a line without one offers none', async () => {
  const id = '543fb3a6-8ce9-490c-8145-b3ab4631108b';
  const source = fileURLToPath(new URL('../__fixtures__/qwen-session.jsonl', import.meta.url));
  const lines = (await readFile(source, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  let n = 0;
  // Qwen 0.27+ writes promptId on every line of a prompt; the first prompt here is from before that.
  const stamped = lines.map((row) => row.type === 'user' && row.provenance === 'real_user' && n++ > 0 ? { ...row, promptId: `${id}########${n}` } : row);
  const turns = await prompts('qwen', 'qwen-session.jsonl', id, (root) => join(root, '-proj', 'chats', `${id}.jsonl`), stamped);
  expect(turns.map(({ anchor, files }) => ({ anchor, files }))).toEqual(
    Array.from({ length: n }, (_, index) => index === 0 ? { anchor: undefined, files: undefined } : { anchor: `${id}########${index + 1}`, files: true }));
});
