import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

async function prompts(harness: SessionRecordLocator['harness'], name: string, id: string, layout: (root: string) => string) {
  const root = await mkdtemp(join(tmpdir(), 'revert-points-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const file = layout(root);
  await mkdir(dirname(file), { recursive: true });
  await copyFile(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), file);
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
