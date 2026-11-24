import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { HOST_PROMPT_HASH, nativePromptMeta, type HostPrompt } from '../acp/native-prompt';
import { createSessionRecordSource, createSessionTimeline } from './index';

// What the host sends for a task turn with an attached picture (`cell.ts`): the picture, the person's words if any, and
// the host's own lines saying where the file is (`turnAttachmentText`).
const HINT = '[Image attached: shot.png]\n[Folder file gugu-file://item?v=1 — show it again: message_send {file: "gugu-file://item?v=1"}]\n[File at local path: /home/u/.gugu/attachments/shot.png]';
const FILE = { itemId: 'item', version: 1, name: 'shot.png', mimeType: 'image/png', sizeBytes: 4 };
const PNG = 'iVBORw0KGgo=';
const sent = (words: string) => [{ type: 'image', data: PNG, mimeType: 'image/png' }, ...(words ? [{ type: 'text', text: words }] : []), { type: 'text', text: HINT }];
const receipt = (words: string): [string, HostPrompt] => [nativePromptMeta(sent(words))[HOST_PROMPT_HASH]!, { text: words, files: [FILE] }];

const THREAD = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
const SESSION = '11111111-2222-4333-8444-555555555555';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A record as each agent writes these prompts: Codex joins a run of text into one input, Claude keeps each block. `running`: Codex has not ended the last turn yet. */
async function record(harness: 'codex' | 'claude', prompts: string[], running = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `host-prompts-${harness}-`));
  roots.push(root);
  const at = (s: number) => `2026-11-23T00:00:${String(s).padStart(2, '0')}.000Z`;
  if (harness === 'codex') {
    const line = (type: string, payload: object, s: number) => JSON.stringify({ timestamp: at(s), type, payload });
    const lines = [line('session_meta', { id: THREAD, cwd: '/w' }, 0), ...prompts.flatMap((words, i) => [
      line('event_msg', { type: 'task_started', turn_id: `t${i}` }, 2 * i + 1),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
        { type: 'input_text', text: [words, HINT].filter(Boolean).join('\n') }] }, 2 * i + 1),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${i}` }] }, 2 * i + 2),
      ...(running && i === prompts.length - 1 ? [] : [line('event_msg', { type: 'task_complete', turn_id: `t${i}` }, 2 * i + 2)]),
    ])];
    const day = join(root, '2026', '11', '23');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-2026-11-23T00-00-00-${THREAD}.jsonl`), lines.join('\n') + '\n');
  } else {
    const lines = prompts.flatMap((words, i) => [
      JSON.stringify({ type: 'user', uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, sessionId: SESSION, timestamp: at(2 * i + 1),
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          ...(words ? [{ type: 'text', text: words }] : []), { type: 'text', text: HINT }] } }),
      JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, sessionId: SESSION, timestamp: at(2 * i + 2),
        message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }], stop_reason: 'end_turn' } }),
    ]);
    await mkdir(join(root, 'project'), { recursive: true });
    await writeFile(join(root, 'project', `${SESSION}.jsonl`), lines.join('\n') + '\n');
  }
  return root;
}

const users = (turns: readonly TranscriptTurn[]) => turns.flatMap((turn) => turn.items.flatMap((item) =>
  item.kind === 'message' && item.role === 'user' ? [{ text: item.text, files: item.files?.map((file) => file.name) }] : []));

describe.each(['codex', 'claude'] as const)('a %s record shows what the person sent with a picture', (harness) => {
  const providerSessionId = harness === 'codex' ? THREAD : SESSION;

  it('their words alone, with the picture alone or beside words; never the host lines sent to the agent', async () => {
    const root = await record(harness, ['', 'look at this']);
    const kept = new Map([receipt(''), receipt('look at this')]);
    const timeline = await createSessionTimeline(createSessionRecordSource({ harness, providerSessionId, roots: [root] }),
      { sessionId: 'S', hostPrompts: (digest) => kept.get(digest) });
    try {
      const turns = timeline.getSnapshot({ limit: 100 }).turns;
      expect(users(turns)).toEqual([{ text: '', files: ['shot.png'] }, { text: 'look at this', files: ['shot.png'] }]);
      expect(JSON.stringify(turns)).not.toContain('File at local path');
    } finally { timeline.dispose(); }
  });

  it('the record as it is where the host kept no receipt', async () => {
    const root = await record(harness, ['']);
    const timeline = await createSessionTimeline(createSessionRecordSource({ harness, providerSessionId, roots: [root] }), { sessionId: 'S' });
    try {
      expect(users(timeline.getSnapshot({ limit: 100 }).turns).map((one) => one.text)).toEqual([HINT]);
    } finally { timeline.dispose(); }
  });
});

describe('a running turn that sent only a picture', () => {
  // The runtime's copy: the person's (empty) words and the file, with the receipt of what was sent (`cell.ts`).
  const runtime = { id: 'S:turn:live', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'S:turn:live:message:client-1', seq: 0,
    role: 'user', text: '', files: [FILE], _meta: { guguClientMessageId: 'client-1', ...nativePromptMeta(sent('')) } }] } as TranscriptTurn;

  it('is shown once, as the runtime holds it, and its record copy reads as sent once it ends', async () => {
    const root = await record('codex', [''], true);
    const timeline = await createSessionTimeline(createSessionRecordSource({ harness: 'codex', providerSessionId: THREAD, roots: [root] }), { sessionId: 'S' });
    try {
      timeline.syncActiveTurn(runtime);
      expect(timeline.getSnapshot({ limit: 100 }).turns.map((turn) => turn.id)).toEqual(['S:turn:live']);
      timeline.syncActiveTurn(null);
      expect(users(timeline.getSnapshot({ limit: 100 }).turns)).toEqual([{ text: '', files: ['shot.png'] }]);
    } finally { timeline.dispose(); }
  });

  it('sent again, leaves the turn the same picture opened before in place', async () => {
    const root = await record('codex', ['']);
    const timeline = await createSessionTimeline(createSessionRecordSource({ harness: 'codex', providerSessionId: THREAD, roots: [root] }), { sessionId: 'S' });
    try {
      const before = timeline.getSnapshot({ limit: 100 }).turns.map((turn) => turn.id);
      expect(before).toHaveLength(1);
      timeline.syncActiveTurn(runtime);
      expect(timeline.getSnapshot({ limit: 100 }).turns.map((turn) => turn.id)).toEqual([...before, 'S:turn:live']);
    } finally { timeline.dispose(); }
  });
});
