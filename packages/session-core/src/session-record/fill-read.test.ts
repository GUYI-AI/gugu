import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { SessionRecordLocator, TurnStart } from './contract';
import { readRecordFrom } from './fill-read';
import { readElidedPicture } from './sources/picture-elider';
import { createSessionRecordSource, createSessionTimeline } from './index';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// Enough turns that settled ones are handed out while the record streams (the drain holds the newest back).
const TURNS = 150;

async function codexRecord(): Promise<SessionRecordLocator> {
  const thread = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
  const root = await temp('fill-read-codex-');
  const day = join(root, '2026', '06', '18');
  await mkdir(day, { recursive: true });
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
  const fixture = (await readFile(fileURLToPath(new URL('./__fixtures__/codex-rollout.jsonl', import.meta.url)), 'utf8')).trim();
  const turns = Array.from({ length: TURNS }, (_, n) => [
    line('event_msg', { type: 'task_started' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `question ${n % 7}` }] }),
    line('response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: `call-${n}` }),
    line('response_item', { type: 'function_call_output', call_id: `call-${n}`, output: n % 10 ? `out ${n}`
      : [{ type: 'input_image', image_url: `data:image/png;base64,${String(n).padStart(4, '0').repeat(25_000)}` }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${n % 7}` }] }),
    line('event_msg', { type: 'task_complete' }),
  ]).flat();
  await writeFile(join(day, `rollout-2026-06-18T07-03-21-${thread}.jsonl`), [fixture, ...turns, ...turns.slice(0, 2)].join('\n') + '\n');
  return { harness: 'codex', providerSessionId: thread, roots: [root] };
}

async function claudeRecord(): Promise<SessionRecordLocator> {
  const id = 'f1b2c3d4-0000-4000-8000-000000000002';
  const root = await temp('fill-read-claude-');
  await mkdir(join(root, 'project'));
  let parent: string | null = null;
  const lines = Array.from({ length: TURNS }, (_, n) => (['user', 'assistant'] as const).map((role) => {
    const uuid = `${role}-${n}`;
    const line = JSON.stringify({ type: role, uuid, parentUuid: parent, sessionId: id, timestamp: '2026-10-31T00:00:00Z',
      message: { id: uuid, role, content: [{ type: 'text', text: `${role} ${n % 7}` }], ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) } });
    parent = uuid;
    return line;
  })).flat();
  await writeFile(join(root, 'project', `${id}.jsonl`), lines.join('\n') + '\n');
  return { harness: 'claude', providerSessionId: id, roots: [root] };
}

async function hermesRecord(): Promise<SessionRecordLocator> {
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./__fixtures__/hermes-state.json', import.meta.url)), 'utf8')) as {
    session: { id: string; ended_at: number }; messages: Array<Record<string, unknown> & { id: number }> };
  const path = join(await temp('fill-read-hermes-'), 'state.db');
  const db = new Database(path);
  db.exec(`
    create table sessions (id text primary key, ended_at real);
    create table messages (
      id integer primary key autoincrement, session_id text not null, role text not null, content text,
      tool_call_id text, tool_calls text, tool_name text, timestamp real not null, finish_reason text,
      reasoning text, reasoning_content text, active integer not null default 1, compacted integer not null default 0,
      _compressed_summary integer not null default 0, display_kind text);
  `);
  db.prepare('insert into sessions (id, ended_at) values (?, null)').run(fixture.session.id);
  const insert = db.prepare(`insert into messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason,
    reasoning, reasoning_content, active, compacted, _compressed_summary, display_kind)
    values (@session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name, @timestamp, @finish_reason,
    @reasoning, @reasoning_content, @active, @compacted, @_compressed_summary, @display_kind)`);
  const blank = { tool_call_id: null, tool_calls: null, tool_name: null, finish_reason: null, reasoning: null, reasoning_content: null,
    active: 1, compacted: 0, _compressed_summary: 0, display_kind: null };
  for (const { id: _id, ...row } of fixture.messages) insert.run({ ...blank, ...row, session_id: fixture.session.id });
  // Another session's rows interleave: positions are ids in a database every Hermes session shares.
  db.prepare("insert into sessions (id, ended_at) values ('other', null)").run();
  for (let n = 0; n < TURNS; n += 1) {
    insert.run({ ...blank, session_id: fixture.session.id, role: 'user', content: `question ${n % 7}`, timestamp: 1_800_000_000 + n });
    insert.run({ ...blank, session_id: 'other', role: 'user', content: 'elsewhere', timestamp: 1_800_000_000 + n });
    insert.run({ ...blank, session_id: fixture.session.id, role: 'assistant', content: `answer ${n % 7}`, finish_reason: 'stop', timestamp: 1_800_000_000 + n });
  }
  db.close();
  return { harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] };
}

/** Equal, or an error that shows where the two first differ. */
function same(got: unknown, want: unknown): void {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g === w) return;
  let at = 0;
  while (at < g.length && g[at] === w[at]) at++;
  throw new Error(`differs at ${at}:\n  got:  …${g.slice(Math.max(0, at - 200), at + 200)}\n  want: …${w.slice(Math.max(0, at - 200), at + 200)}`);
}

const said = (turns: readonly TranscriptTurn[]) => turns.map((turn) => turn.items.flatMap((item) =>
  item.kind === 'message' ? [`${item.role}: ${item.text}`] : []).join(' | '));

async function readAll(locator: SessionRecordLocator, start: TurnStart | null, options: { turn?: number; fill?: boolean } = {}) {
  const turns: TranscriptTurn[] = [];
  const starts: Array<TurnStart | null> = [];
  let handedOut = 0;
  const read = await readRecordFrom({ locator, sessionId: 'fill', position: start?.position ?? 0, fill: options.fill,
    ...(start ? { at: { state: start.state, timeline: start.timeline, turn: options.turn ?? 0 } } : {}), onSettled: (batch, from, at) => {
    expect(from).toBe(turns.length);
    handedOut += batch.length;
    turns.push(...batch); starts.push(...at);
  } });
  turns.push(...read.tail); starts.push(...read.tailStarts);
  return { turns, starts, from: read.from, handedOut };
}

describe.each([['codex', codexRecord], ['claude', claudeRecord], ['hermes', hermesRecord]] as const)('readRecordFrom over a %s record', (_name, make) => {
  it('streams the same turns as a whole-record timeline, handing settled ones out as it goes', async () => {
    const locator = await make();
    const timeline = await createSessionTimeline(createSessionRecordSource(locator, { readMode: 'snapshot' }), { sessionId: 'fill' });
    const whole = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
    timeline.dispose();
    const read = await readAll(locator, null);
    expect(read.turns).toEqual(whole);
    expect(read.handedOut).toBeGreaterThan(TURNS / 2);
    expect(whole.length).toBeGreaterThanOrEqual(TURNS);
  });

  it('reads from a turn it reported, with the state and turn index there, exactly as a whole read goes on', async () => {
    const locator = await make();
    const whole = await readAll(locator, null, { fill: true });
    expect(whole.starts.every((start) => start !== null)).toBe(true);
    for (const at of [1, 40, whole.turns.length - 3, whole.turns.length - 1]) {
      const from = await readAll(locator, whole.starts[at], { turn: at, fill: true });
      expect(from.from).toBe(whole.starts[at]!.position);
      same(from.turns, whole.turns.slice(at));
      same(from.starts, whole.starts.slice(at));
    }
  });
});

it('reads a grown Codex record from a position without the lines before it', async () => {
  const locator = await codexRecord();
  const whole = await readAll(locator, null, { fill: true });
  const at = whole.turns.length - 2;
  const file = join(locator.roots[0], '2026', '06', '18', `rollout-2026-06-18T07-03-21-${locator.providerSessionId}.jsonl`);
  await appendFile(file, [
    JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'grown' }] } }),
  ].join('\n') + '\n');
  const from = await readAll(locator, whole.starts[at], { turn: at, fill: true });
  expect(said(from.turns)).toEqual([...said(whole.turns.slice(at)), 'user: grown']);
});

it('passes pictures over without moving a turn start, keeping their place in the record', async () => {
  const locator = await codexRecord();
  const whole = await readAll(locator, null);
  const passed = await readAll(locator, null, { fill: true });
  expect(passed.starts.map((start) => start?.position)).toEqual(whole.starts.map((start) => start?.position));
  expect(said(passed.turns)).toEqual(said(whole.turns));
  const images = (turns: TranscriptTurn[]) => turns.flatMap((turn) => turn.items.flatMap((item) =>
    (item as { images?: Array<{ data: string }> }).images?.map((image) => image.data) ?? []));
  const file = join(locator.roots[0], '2026', '06', '18', `rollout-2026-06-18T07-03-21-${locator.providerSessionId}.jsonl`);
  const bytes = await readFile(file);
  const shown = images(passed.turns);
  expect(shown).toHaveLength(TURNS / 10);
  expect(shown.map((data) => {
    const place = readElidedPicture(data)!;
    return bytes.subarray(place.start, place.start + place.chars).toString('latin1');
  })).toEqual(images(whole.turns));
});

it('merges child records in a fixed order: the same record reads the same every time', async () => {
  const thread = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
  const root = await temp('fill-read-children-');
  const day = join(root, '2026', '06', '18');
  await mkdir(day, { recursive: true });
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
  const children = Array.from({ length: 6 }, (_, n) => `child-${n}`);
  // Children of different sizes, so their reads finish in a different order from the one they started in.
  for (const [n, id] of children.entries()) {
    await writeFile(join(day, `rollout-2026-06-18T07-03-21-${id}.jsonl`), [
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${id}` }] }),
      ...Array.from({ length: (6 - n) * 40 }, (_, k) => line('response_item', { type: 'function_call', name: 'exec_command', call_id: `${id}-${k}`, arguments: '{}' })),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `result ${id}` }] }),
      line('event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n');
  }
  await writeFile(join(day, `rollout-2026-06-18T07-03-21-${thread}.jsonl`), [
    line('event_msg', { type: 'task_started' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start them' }] }),
    ...children.flatMap((id) => [
      line('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: `spawn-${id}`, arguments: JSON.stringify({ task_name: id, message: `task ${id}` }) }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: `spawn-${id}`, kind: 'started', agent_thread_id: id, agent_path: `/root/${id}` } }),
    ]),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'started' }] }),
  ].join('\n') + '\n');
  const locator: SessionRecordLocator = { harness: 'codex', providerSessionId: thread, roots: [root] };
  const first = JSON.stringify((await readAll(locator, null)).turns);
  for (let read = 0; read < 20; read++) expect(JSON.stringify((await readAll(locator, null)).turns)).toBe(first);
});
