import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { SessionRecordLocator } from './contract';
import { createSessionRecordSource } from './index';
import { readRecordForIngest } from './ingest';
import { createSessionTimeline, type TimelineArchive } from './timeline';

/**
 * resume-mem: ingesting a record in two reads (cut anywhere, checkpoint, append the rest, resume) must give exactly the
 * turns one full read gives. Every line of every scenario is a cut point, so cuts fall mid-turn, mid-subagent and
 * between a turn's end and a late fragment of it.
 */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

const fixture = async (name: string) => (await readFile(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'))
  .split('\n').filter((line) => line.trim());

/** Copies of a fixture must be distinct conversations: every native id gets the copy number. */
const remapIds = (text: string, copy: number) => text
  .replace(/"((?:msg|toolu|call|rs|fc|resp)_)([A-Za-z0-9]+)"/g, (_all, prefix: string, rest: string) => `"${prefix}c${copy}${rest}"`)
  .replace(/"([0-9a-f]{8})(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g,
    (_all, head: string, rest: string) => `"${copy.toString(16).padStart(2, '0')}${head.slice(2)}${rest}"`)
  .replace(/"turn-(\d+)"/g, (_all, n: string) => `"turn-${copy}-${n}"`);

/** A scenario: files relative to the root, and every line in the order it was written. */
type Scenario = { locator: (root: string) => SessionRecordLocator; writes: Array<[file: string, line: string]> };

async function codex(name: string, copies: number): Promise<Scenario> {
  const lines = await fixture(name);
  const thread = 'ingest-thread';
  const file = `2026/06/18/rollout-2026-06-18T07-03-21-${thread}.jsonl`;
  const head = lines.filter((line) => line.includes('"session_meta"'));
  const body = lines.filter((line) => !line.includes('"session_meta"'));
  return {
    locator: (root) => ({ harness: 'codex', providerSessionId: thread, roots: [root] }),
    writes: [...head.map((line) => [file, line] as [string, string]),
      ...Array.from({ length: copies }, (_, copy) => body.map((line) => [file, remapIds(line, copy)] as [string, string])).flat()],
  };
}

async function claude(name: string, copies: number): Promise<Scenario> {
  const lines = await fixture(name);
  const session = /"sessionId":"([^"]+)"/.exec(lines[0])![1];
  const file = `project/${session}.jsonl`;
  const writes: Array<[string, string]> = [];
  let last: string | null = null;
  for (let copy = 0; copy < copies; copy += 1) {
    // Each copy gets its own ids and hangs off the previous copy's last line: one long linear conversation.
    for (const line of lines) {
      const record = JSON.parse(remapIds(line, copy)) as { parentUuid?: string | null; uuid?: string };
      if (record.parentUuid === null && last) record.parentUuid = last;
      if (record.uuid) last = record.uuid;
      writes.push([file, JSON.stringify(record)]);
    }
  }
  return { locator: (root) => ({ harness: 'claude', providerSessionId: session, roots: [root] }), writes };
}

function claudeWithChildren(): Scenario {
  const text = (value: string) => ({ type: 'text', text: value });
  const line = (uuid: string, type: 'user' | 'assistant', content: unknown[], extra: object = {}) => JSON.stringify({
    uuid, type, sessionId: 'parent', timestamp: '2026-10-26T11:40:00Z', message: { role: type, id: uuid, content }, ...extra });
  const end = (uuid: string, value: string, extra: object = {}) => JSON.stringify({ ...JSON.parse(line(uuid, 'assistant', [text(value)], extra)),
    message: { role: 'assistant', id: uuid, content: [text(value)], stop_reason: 'end_turn' } });
  const launch = (id: string) => ({ type: 'tool_use', id, name: 'Agent', input: { description: 'Audit', prompt: 'Audit', run_in_background: true } });
  const launched = (uuid: string, call: string, agent: string) => line(uuid, 'user', [{ type: 'tool_result', tool_use_id: call, content: 'Agent launched' }],
    { toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent } });
  const child = { isSidechain: true, agentId: 'worker' };
  const parent = 'project/parent.jsonl', worker = 'project/parent/subagents/agent-worker.jsonl';
  return {
    locator: (root) => ({ harness: 'claude', providerSessionId: 'parent', roots: [root] }),
    writes: [
      [parent, line('u1', 'user', [text('Inspect the repository')])],
      [parent, line('l1', 'assistant', [launch('call-1')])],
      // The child's file exists by the time the parent records the launch (dev reports a missing one as unavailable too).
      [worker, line('c1', 'user', [text('Audit')], child)],
      [parent, launched('d1', 'call-1', 'worker')],
      [parent, end('e1', 'PARENT_FIRST')],
      [worker, line('c2', 'assistant', [{ type: 'tool_use', id: 'step', name: 'Bash', input: { command: 'inspect' } }], child)],
      [parent, line('u2', 'user', [text('And the tests?')], { parentUuid: 'e1' })],
      [worker, end('c3', 'CHILD_DONE', child)],
      [parent, end('e2', 'PARENT_SECOND', { parentUuid: 'u2' })],
      [parent, line('u3', 'user', [text('Thanks')], { parentUuid: 'e2' })],
      [parent, end('e3', 'PARENT_THIRD', { parentUuid: 'u3' })],
    ],
  };
}

async function stage(scenario: Scenario, upTo: number) {
  const root = await mkdtemp(join(tmpdir(), 'ingest-equivalence-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const write = async (from: number, to: number) => {
    for (const [file, line] of scenario.writes.slice(from, to)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await appendFile(join(root, file), `${line}\n`);
    }
  };
  await write(0, upTo);
  return { root, locator: scenario.locator(root), rest: () => write(upTo, scenario.writes.length) };
}

/** Ingest once, keeping every handed-out turn by its record index. */
async function ingest(locator: SessionRecordLocator, checkpoint: TimelineArchive | null, into: Map<number, TranscriptTurn>) {
  const read = await readRecordForIngest({ locator, sessionId: 's1', checkpoint,
    onSettled: (turns, from) => turns.forEach((turn, offset) => into.set(from + offset, turn)) });
  read.tail.forEach((turn, offset) => into.set(read.tailFrom + offset, turn));
  // Anything past the end of this read was a previous read's guess about turns that no longer exist.
  for (const index of [...into.keys()]) if (index >= read.tailFrom + read.tail.length) into.delete(index);
  return read;
}

/**
 * What the interactive timeline shows after the same two moments: opened at the cut, then caught up. Records split over
 * files (a subagent's own file) depend on when each file was read, so this, not one full read, is their oracle.
 */
async function liveAcrossCut(locator: SessionRecordLocator, rest: () => Promise<void>): Promise<TranscriptTurn[]> {
  const timeline = await createSessionTimeline(createSessionRecordSource(locator, { pollIntervalMs: 3_600_000 }), { sessionId: 's1' });
  try {
    await rest();
    await timeline.catchUp();
    return timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
  } finally { timeline.dispose(); }
}

/** Every item of a session, without the turn it sits in: nothing lost, nothing doubled, every card in its final state. */
function itemsOf(turns: readonly TranscriptTurn[]): string[] {
  const out: string[] = [];
  const visit = (items: readonly unknown[]) => {
    for (const raw of items) {
      const item = raw as { kind: string; toolCallId?: string; text?: string; outputText?: string; status?: string; agentStatus?: string; children?: unknown[] };
      out.push(JSON.stringify([item.kind, item.toolCallId ?? null, item.text ?? item.outputText ?? null, item.status ?? null, item.agentStatus ?? null]));
      if (item.children) visit(item.children);
    }
  };
  for (const turn of turns) visit(turn.items);
  return out.sort();
}

async function fullRead(locator: SessionRecordLocator): Promise<TranscriptTurn[]> {
  const timeline = await createSessionTimeline(createSessionRecordSource(locator), { sessionId: 's1' });
  try { return timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns; } finally { timeline.dispose(); }
}

/** `oneFile`: the whole record is one file, so two reads must also equal a single full read. */
const scenarios: Array<[string, () => Promise<Scenario> | Scenario, boolean]> = [
  ['codex, four copies of a turn', () => codex('codex-rollout.jsonl', 4), true],
  ['codex with steering', () => codex('codex-steered-rollout.jsonl', 3), true],
  ['claude, three linked copies', () => claude('claude-session.jsonl', 3), true],
  ['claude with steering', () => claude('claude-steered-session.jsonl', 2), true],
  ['claude whose final fragments land after the turn end', () => claude('claude-final-fragments.jsonl', 3), true],
  ['claude with a background subagent file', claudeWithChildren, false],
];

describe('ingest in two reads equals one full read', () => {
  it.each(scenarios)('%s, cut at every line', async (_name, make, oneFile) => {
    const scenario = await make();
    const whole = await stage(scenario, scenario.writes.length);
    const full = await fullRead(whole.locator);
    expect(full.length).toBeGreaterThan(0);
    for (let cut = 1; cut < scenario.writes.length; cut += 1) {
      const live = await stage(scenario, cut);
      const expected = await liveAcrossCut(live.locator, live.rest);
      if (oneFile) expect({ cut, turns: expected }).toEqual({ cut, turns: full });
      const staged = await stage(scenario, cut);
      const turns = new Map<number, TranscriptTurn>();
      const first = await ingest(staged.locator, null, turns);
      // Round-trip the checkpoint as the child does: through JSON on disk.
      const saved = JSON.parse(JSON.stringify(first.checkpoint)) as TimelineArchive;
      await staged.rest();
      const second = await ingest(staged.locator, saved, turns);
      expect({ cut, resumed: second.resumed }).toEqual({ cut, resumed: true });
      const got = [...turns.keys()].sort((a, b) => a - b).map((index) => turns.get(index)!);
      // One file: exactly the full read. Several files: which turn a child's line lands in depends on when each file was
      // read (the live view and dev's own fills differ too), so only the items must match.
      if (oneFile) expect({ cut, turns: got }).toEqual({ cut, turns: expected });
      else expect({ cut, items: itemsOf(got) }).toEqual({ cut, items: itemsOf(full) });
    }
  });
});

describe('a .zst archive resumes on the .jsonl Codex materializes from it', () => {
  it('is not read again while unchanged, and reads only the appended part once materialized', async () => {
    const scenario = await codex('codex-rollout.jsonl', 4);
    const whole = await stage(scenario, scenario.writes.length);
    const expected = await fullRead(whole.locator);
    const half = Math.floor(scenario.writes.length / 2);
    const staged = await stage(scenario, half);
    const plain = join(staged.root, scenario.writes[0][0]);
    await pipeline(createReadStream(plain), createZstdCompress(), createWriteStream(`${plain}.zst`));
    await rm(plain);
    const turns = new Map<number, TranscriptTurn>();
    const first = await ingest(staged.locator, null, turns);
    expect(first.checkpoint).not.toBeNull();
    const saved = JSON.parse(JSON.stringify(first.checkpoint)) as TimelineArchive;
    expect((await readRecordForIngest({ locator: staged.locator, sessionId: 's1', checkpoint: saved, onSettled: () => {} })).status).toBe('unchanged');
    // Codex materializes the archive to plain JSONL before it appends (rollout compression.rs).
    await pipeline(createReadStream(`${plain}.zst`), (await import('node:zlib')).createZstdDecompress(), createWriteStream(plain));
    await rm(`${plain}.zst`);
    await staged.rest();
    const settled: number[] = [];
    const second = await readRecordForIngest({ locator: staged.locator, sessionId: 's1', checkpoint: saved,
      onSettled: (batch, from) => batch.forEach((turn, offset) => { settled.push(from + offset); turns.set(from + offset, turn); }) });
    second.tail.forEach((turn, offset) => turns.set(second.tailFrom + offset, turn));
    expect(second.resumed).toBe(true);
    expect(Math.min(...settled, second.tailFrom)).toBeGreaterThanOrEqual(first.tailFrom);
    expect([...turns.keys()].sort((a, b) => a - b).map((index) => turns.get(index))).toEqual(expected);
  });

  it('reads from the start when the materialized file does not start with the archive', async () => {
    const scenario = await codex('codex-rollout.jsonl', 2);
    const staged = await stage(scenario, scenario.writes.length);
    const plain = join(staged.root, scenario.writes[0][0]);
    await pipeline(createReadStream(plain), createZstdCompress(), createWriteStream(`${plain}.zst`));
    const original = await readFile(plain, 'utf8');
    await rm(plain);
    const first = await ingest(staged.locator, null, new Map());
    await rm(`${plain}.zst`);
    await writeFile(plain, original.replace('"type"', '"type" '));
    const second = await ingest(staged.locator, JSON.parse(JSON.stringify(first.checkpoint)) as TimelineArchive, new Map());
    expect(second.resumed).toBe(false);
  });
});
