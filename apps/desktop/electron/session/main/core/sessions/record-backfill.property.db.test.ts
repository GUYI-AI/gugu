/**
 * resume-tail equivalence, by random records (EQUIVALENCE.md): a store filled step by step — stamp, cursor, streamed
 * turns, pictures left in the record — equals, row for row, the store the whole-record fill of before builds on the
 * same steps (`oracleFill`, dev's algorithm), and so do the received delivery ids.
 *
 * Each sample is a seeded random record of Codex, Claude or Hermes turns (repeated prompts, tool calls, short and long
 * pictures, delivery envelopes, an unfinished last turn), written in random appends (cut anywhere, mid-turn too), with
 * rewinds, replaced records and `.zst` archives in between; both fills run after every write. A failure is shrunk to
 * a smaller case and reported with its seed. `RESUME_PROPERTY_SAMPLES` / `RESUME_PROPERTY_SEED` scale and pin a run; `RESUME_PROPERTY_REPORT` names a file for its readings.
 */
import { openFixture } from '@tooling/utils/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { buildSessionDirectEnvelope, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

type Row = { runtime: string; provider: string; providerSessionId: string; agentStatus: string | null; archivedAt: string | null;
  config: { forkedFrom: { sessionId: string } } | undefined };
const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, root: '', rows: new Map<string, Row>() }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/session-timeline/service', () => ({
  readSessionRow: (id: string) => state.rows.get(id) ?? null,
  locateRow: (row: Row) => ({ supported: true, locator: { harness: row.provider, providerSessionId: row.providerSessionId, roots: [state.root] } }),
}));
vi.mock('@main/core/session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider: string) => provider }));
vi.mock('@main/core/session-timeline/write-bridge', () => ({ acpSessionLive: async () => false }));
vi.mock('./session-process', () => ({ sessionProcess: () => null, sessionEngine: async () => 'gone' }));

import { createSessionRecordSource, createSessionTimeline, type RecordLineageNode } from '@gugu/session-core/session-record';
import { recordedDeliveryIds, syncStoredHistoryFromRecord } from './record-backfill';
import { recordIdentityFor, recordTurnsAfterStore } from './record-backfill-match';
import {
  appendRecordTurnNow, getStoredToolImage, readStoredTailNow, readUnfinishedRecordTurnsNow, reviseRecordTurnNow, withStoredTurns,
} from './session-turn-store';

// ─── random ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function random(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}

type Harness = 'codex' | 'claude' | 'hermes';
type Picture = { chars: number; fill: string };
type Turn = {
  prompt: string; reply: string; tool?: { id: string; picture?: Picture; text?: string }; done: boolean;
  /** A subagent this turn starts (its own record); `later` = it finishes in a later turn (Claude: a background agent,
   * else a foreground one whose result is its finish). */
  sub?: { id: string; later: boolean };
  /** The later turn a subagent finishes in. */
  subDone?: string;
};
type Op = { kind: 'grow'; turns: Turn[]; cuts: number } | { kind: 'rewind'; keep: number } | { kind: 'replace'; turns: Turn[] } | { kind: 'archive' };
/** `fork` (Claude): the parent's turns; the record copies them and goes on, as `--fork-session` does. */
type Case = { seed: number; harness: Harness; ops: Op[]; fork?: Turn[] };

const PROMPTS = ['continue', 'ok', 'check it', 'again'];
const REPLIES = ['done', 'ok', 'checked'];
const DELIVERED = Array.from({ length: 6 }, (_, n) => `d${n}000000-0000-4000-8000-00000000000${n}`);
const envelope = (id: string) => buildSessionDirectEnvelope({ senderSessionId: 'peer', senderTitle: 'Peer', messageId: id, content: `ask ${id.slice(0, 2)}`, at: '2026-11-09 08:00 UTC+0' });

function randomTurns(r: ReturnType<typeof random>, harness: Harness, count: number, tag: string, envelopes = true): Turn[] {
  const turns = Array.from({ length: count }, (_, n): Turn => {
    const picture = harness !== 'hermes' && r.chance(0.35)
      ? { chars: r.chance(0.5) ? r.int(70, 110) * 1024 : r.int(1, 8) * 512, fill: r.pick(['QUJD', 'WFla', 'MTIz', 'cXdl']) } : undefined;
    const tool = r.chance(0.5) ? { id: `t${tag}${n}`, ...(picture ? { picture } : { text: r.pick(REPLIES) }) } : undefined;
    const sub = harness !== 'hermes' && r.chance(0.15) ? { id: `child-${tag}-${n}`, later: r.chance(0.5) } : undefined;
    return {
      prompt: envelopes && r.chance(0.15) ? envelope(r.pick(DELIVERED)) : r.pick(PROMPTS),
      reply: r.pick(REPLIES), ...(tool ? { tool } : {}), ...(sub ? { sub } : {}), done: true,
    };
  });
  // A subagent that finishes later does so in a later turn of the batch, if there is one (else it never finishes).
  turns.forEach((turn, n) => {
    if (!turn.sub?.later) return;
    const after = turns.slice(n + 1).find((later) => !later.subDone);
    if (after) after.subDone = turn.sub.id;
  });
  return turns;
}

function randomCase(seed: number): Case {
  const r = random(seed);
  const harness = r.pick(['codex', 'claude', 'hermes'] as const);
  const ops: Op[] = [];
  let length = 0;
  for (let i = 0, n = r.int(1, 6); i < n; i++) {
    const roll = r.next();
    if (length > 1 && roll < 0.12) { const keep = r.int(1, length - 1); ops.push({ kind: 'rewind', keep }); length = keep; }
    else if (length > 0 && roll < 0.2) { const turns = randomTurns(r, harness, r.int(1, 6), `r${i}`); ops.push({ kind: 'replace', turns }); length = turns.length; }
    else if (harness === 'codex' && length > 0 && roll < 0.3) ops.push({ kind: 'archive' });
    else { const turns = randomTurns(r, harness, r.int(1, 8), `g${i}`); ops.push({ kind: 'grow', turns, cuts: r.int(1, 4) }); length += turns.length; }
  }
  const last = [...ops].reverse().find((op): op is Extract<Op, { kind: 'grow' }> => op.kind === 'grow');
  if (last && r.chance(0.3)) last.turns.at(-1)!.done = false;
  // A forked session's own deliveries arrive after it exists: none is in the turns it inherits.
  const fork = harness === 'claude' && r.chance(0.3)
    ? randomTurns(r, harness, r.int(1, 4), 'p', false).map(({ sub: _sub, subDone: _done, ...turn }) => turn) : undefined;
  return { seed, harness, ops, ...(fork ? { fork } : {}) };
}

// ─── records ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const THREAD = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
const CLAUDE = 'f1b2c3d4-0000-4000-8000-0000000000aa';
const PARENT = 'f1b2c3d4-0000-4000-8000-0000000000bb';
const HERMES = '20261109_000000_prop00';
const pictureData = (p: Picture) => p.fill.repeat(Math.ceil(p.chars / p.fill.length)).slice(0, p.chars);

const codexLine = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
/** The parent's record noting a subagent finished, then the child's final answer handed to the parent (as Codex writes them). */
const subFinished = (id: string) => [
  codexLine('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: `done-${id}`, kind: 'completed', agent_thread_id: id, agent_path: `/root/${id}` } }),
  codexLine('response_item', { type: 'agent_message', author: `/root/${id}`, recipient: '/root',
    content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/${id}\nPayload:\nresult of ${id}` }] }),
];
/** A subagent's own record: written when it starts, finished when the parent records it finishing. */
const childLines = (id: string, finished: boolean) => [
  codexLine('event_msg', { type: 'task_started' }),
  codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${id}` }] }),
  codexLine('response_item', { type: 'function_call', name: 'exec_command', call_id: `step-${id}`, arguments: '{}' }),
  codexLine('response_item', { type: 'function_call_output', call_id: `step-${id}`, output: `step of ${id}` }),
  ...(finished ? [
    codexLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `result of ${id}` }] }),
    codexLine('event_msg', { type: 'task_complete' }),
  ] : []),
];

/** A Claude subagent's own record, finished when the parent's record has its result or notification. */
const claudeChildLines = (id: string, finished: boolean) => {
  const line = (uuid: string, role: 'user' | 'assistant', content: unknown[], end = false) => JSON.stringify({ type: role, uuid: `${id}-${uuid}`,
    sessionId: CLAUDE, isSidechain: true, agentId: id, timestamp: '2026-10-31T00:00:00Z',
    message: { id: `m-${id}-${uuid}`, role, content, ...(end ? { stop_reason: 'end_turn' } : {}) } });
  return [
    line('u', 'user', [{ type: 'text', text: `task ${id}` }]),
    line('c', 'assistant', [{ type: 'tool_use', id: `step-${id}`, name: 'Bash', input: { command: 'ls' } }]),
    line('r', 'user', [{ type: 'tool_result', tool_use_id: `step-${id}`, content: `step of ${id}` }]),
    ...(finished ? [line('a', 'assistant', [{ type: 'text', text: `result of ${id}` }], true)] : []),
  ];
};

/** One record line per entry; a turn's lines as the harness writes them. Unique ids come from `n`. */
function codexLines(turns: Turn[], from: number): string[] {
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
  return turns.flatMap((turn, k) => {
    const n = from + k;
    return [
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.prompt }] }),
      ...(turn.sub ? [
        line('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: `spawn-${turn.sub.id}`, arguments: JSON.stringify({ task_name: turn.sub.id, message: `task ${turn.sub.id}` }) }),
        line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: `spawn-${turn.sub.id}`, kind: 'started', agent_thread_id: turn.sub.id, agent_path: `/root/${turn.sub.id}` } }),
        line('response_item', { type: 'function_call_output', call_id: `spawn-${turn.sub.id}`, output: JSON.stringify({ task_name: `/root/${turn.sub.id}` }) }),
        ...(turn.sub.later ? [] : subFinished(turn.sub.id)),
      ] : []),
      ...(turn.subDone ? subFinished(turn.subDone) : []),
      ...(turn.tool ? [
        line('response_item', { type: 'function_call', name: 'shot', arguments: '{}', call_id: `${turn.tool.id}-${n}` }),
        line('response_item', { type: 'function_call_output', call_id: `${turn.tool.id}-${n}`, output: turn.tool.picture
          ? [{ type: 'input_image', image_url: `data:image/png;base64,${pictureData(turn.tool.picture)}` }] : turn.tool.text }),
      ] : []),
      ...(turn.done ? [
        line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.reply }] }),
        line('event_msg', { type: 'task_complete' }),
      ] : []),
    ];
  });
}

function claudeLines(turns: Turn[], from: number, parent: { uuid: string | null }): string[] {
  const out: string[] = [];
  const push = (role: 'user' | 'assistant', uuid: string, content: unknown, end = false, extra: object = {}) => {
    out.push(JSON.stringify({ type: role, uuid, parentUuid: parent.uuid, sessionId: CLAUDE, timestamp: '2026-10-31T00:00:00Z',
      message: { id: `m-${uuid}`, role, content, ...(end ? { stop_reason: 'end_turn' } : {}) }, ...extra }));
    parent.uuid = uuid;
  };
  turns.forEach((turn, k) => {
    const n = from + k;
    push('user', `u${n}`, [{ type: 'text', text: turn.prompt }]);
    if (turn.sub) {
      const { id, later } = turn.sub;
      push('assistant', `s${n}`, [{ type: 'tool_use', id: `agent-${id}`, name: 'Agent', input: { description: `task ${id}`, prompt: `task ${id}`, ...(later ? { run_in_background: true } : {}) } }]);
      push('user', `sr${n}`, [{ type: 'tool_result', tool_use_id: `agent-${id}`, content: [{ type: 'text', text: later ? 'launched' : `result of ${id}` }] }], false,
        { toolUseResult: later ? { isAsync: true, status: 'async_launched', agentId: id }
          : { status: 'completed', agentId: id, content: [{ type: 'text', text: `result of ${id}` }] } });
    }
    if (turn.subDone) {
      push('user', `n${n}`, `<task-notification>\n<task-id>${turn.subDone}</task-id>\n<tool-use-id>agent-${turn.subDone}</tool-use-id>\n`
        + `<status>completed</status>\n<result>result of ${turn.subDone}</result>\n</task-notification>`, false, { origin: { kind: 'task-notification' } });
    }
    if (turn.tool) {
      push('assistant', `c${n}`, [{ type: 'tool_use', id: `${turn.tool.id}-${n}`, name: 'Shot', input: {} }]);
      push('user', `r${n}`, [{ type: 'tool_result', tool_use_id: `${turn.tool.id}-${n}`, content: turn.tool.picture
        ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pictureData(turn.tool.picture) } }]
        : [{ type: 'text', text: turn.tool.text }] }]);
    }
    if (turn.done) push('assistant', `a${n}`, [{ type: 'text', text: turn.reply }], true);
  });
  return out;
}

type HermesRow = { role: string; content: string; tool_call_id?: string; tool_calls?: string; finish_reason?: string };
function hermesRows(turns: Turn[], from: number): HermesRow[] {
  return turns.flatMap((turn, k) => {
    const n = from + k;
    return [
      { role: 'user', content: turn.prompt },
      ...(turn.tool ? [
        { role: 'assistant', content: '', finish_reason: 'tool_calls', tool_calls: JSON.stringify([{ id: `${turn.tool.id}-${n}`, call_id: `${turn.tool.id}-${n}`, type: 'function', function: { name: 'terminal', arguments: '{}' } }]) },
        { role: 'tool', content: JSON.stringify({ output: turn.tool.text ?? 'x' }), tool_call_id: `${turn.tool.id}-${n}` },
      ] : []),
      ...(turn.done ? [{ role: 'assistant', content: turn.reply, finish_reason: 'stop' }] : []),
    ];
  });
}

/** The record on disk, written a version at a time. */
class RecordFile {
  private units: string[] = [];
  private written = 0;
  private archived = false;
  private claudeParent = { uuid: null as string | null };
  private turnUnits: number[] = [];
  /** Codex: a subagent's record changes after a unit (it starts, it finishes). */
  private children = new Map<number, Array<{ id: string; finished: boolean }>>();
  private db: Database.Database | null = null;
  constructor(readonly harness: Harness, readonly root: string, readonly fork?: Turn[]) {}

  get path(): string {
    if (this.harness === 'codex') return join(this.root, '2026', '06', '18', `rollout-2026-06-18T07-03-21-${THREAD}.jsonl`);
    if (this.harness === 'claude') return join(this.root, 'project', `${CLAUDE}.jsonl`);
    return join(this.root, 'state.db');
  }

  async init(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true });
    if (this.harness === 'hermes') {
      this.db = new Database(this.path);
      this.db.exec(`create table sessions (id text primary key, ended_at real);
        create table messages (id integer primary key autoincrement, session_id text not null, role text not null, content text,
          tool_call_id text, tool_calls text, tool_name text, timestamp real not null, finish_reason text, reasoning text,
          reasoning_content text, active integer not null default 1, compacted integer not null default 0,
          _compressed_summary integer not null default 0, display_kind text)`);
      this.db.prepare('insert into sessions (id, ended_at) values (?, null)').run(HERMES);
    } else if (this.harness === 'codex') {
      this.units.push(JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type: 'session_meta', payload: { id: THREAD, timestamp: '2026-06-18T07:03:21Z', cwd: '/work' } }));
    } else if (this.fork) {
      // The parent's own record, and a child record that starts with a copy of it (same uuids).
      const lines = claudeLines(this.fork, 1000, this.claudeParent);
      await writeFile(join(this.root, 'project', `${PARENT}.jsonl`), lines.map((line) => `${line}\n`).join(''));
      for (const line of lines) { if ((JSON.parse(line) as { type: string }).type === 'user' && JSON.parse(line).message.content[0]?.type === 'text') this.turnUnits.push(this.units.length); this.units.push(line); }
    }
  }

  /** Units (lines, rows) of `turns`, numbered after the turns already written. */
  add(turns: Turn[]): string[] {
    const from = this.turnUnits.length;
    const units: string[] = [];
    for (const [k, turn] of turns.entries()) {
      this.turnUnits.push(this.units.length + units.length);
      if (this.harness === 'codex') {
        for (const line of codexLines([turn], from + k)) {
          const item = (JSON.parse(line) as { payload: { name?: string; call_id?: string; item?: { kind?: string; agent_thread_id?: string } } }).payload;
          const child = item.name === 'spawn_agent' ? { id: item.call_id!.slice('spawn-'.length), finished: false }
            : item.item?.kind === 'completed' ? { id: item.item.agent_thread_id!, finished: true } : null;
          if (child) this.children.set(this.units.length + units.length, [...(this.children.get(this.units.length + units.length) ?? []), child]);
          units.push(line);
        }
        continue;
      }
      if (this.harness === 'claude') {
        for (const line of claudeLines([turn], from + k, this.claudeParent)) {
          const record = JSON.parse(line) as { toolUseResult?: { agentId: string; status: string }; message: { content: unknown } };
          const notified = typeof record.message.content === 'string' ? /<task-id>([^<]*)</.exec(record.message.content)?.[1] : undefined;
          const child = record.toolUseResult ? { id: record.toolUseResult.agentId, finished: record.toolUseResult.status === 'completed' }
            : notified ? { id: notified, finished: true } : null;
          if (child) this.children.set(this.units.length + units.length, [...(this.children.get(this.units.length + units.length) ?? []), child]);
          units.push(line);
        }
        continue;
      }
      units.push(...hermesRows([turn], from + k).map((row) => JSON.stringify(row)));
    }
    this.units.push(...units);
    return units;
  }

  /** Write the units up to `count` (an append), materializing an archive first, as Codex does before it appends. */
  async writeUpTo(count: number): Promise<void> {
    if (this.harness === 'hermes') {
      const insert = this.db!.prepare(`insert into messages (session_id, role, content, tool_call_id, tool_calls, finish_reason, timestamp)
        values (@session_id, @role, @content, @tool_call_id, @tool_calls, @finish_reason, @timestamp)`);
      for (const unit of this.units.slice(this.written, count)) {
        const row = JSON.parse(unit) as HermesRow;
        insert.run({ session_id: HERMES, tool_call_id: null, tool_calls: null, finish_reason: null, ...row, timestamp: 1_800_000_000 + this.written });
        this.written++;
      }
      return;
    }
    if (this.archived) {
      await writeFile(this.path, zstdDecompressSync(await readFile(`${this.path}.zst`)));
      await rm(`${this.path}.zst`);
      this.archived = false;
    }
    await writeFile(this.path, this.units.slice(0, count).map((unit) => `${unit}\n`).join(''));
    this.written = count;
    // Each subagent's record as it stands once the parent's record is written up to here.
    const children = new Map<string, boolean>();
    for (const [at, changes] of [...this.children].sort(([a], [b]) => a - b)) {
      if (at >= count) break;
      for (const change of changes) children.set(change.id, children.get(change.id) || change.finished);
    }
    for (const [id, finished] of children) {
      if (this.harness === 'claude') {
        await mkdir(join(this.root, 'project', CLAUDE, 'subagents'), { recursive: true });
        await writeFile(join(this.root, 'project', CLAUDE, 'subagents', `agent-${id}.jsonl`), claudeChildLines(id, finished).map((line) => `${line}\n`).join(''));
      } else await writeFile(join(this.root, '2026', '06', '18', `rollout-2026-06-18T07-03-21-${id}.jsonl`), childLines(id, finished).map((line) => `${line}\n`).join(''));
    }
  }

  /** Keep the first `turns` turns: the record is cut back (a rewind) — a Hermes rewind deletes the rows. */
  async rewind(turns: number): Promise<void> {
    const cut = this.turnUnits[turns] ?? this.units.length;
    this.units = this.units.slice(0, cut);
    this.turnUnits = this.turnUnits.slice(0, turns);
    for (const at of [...this.children.keys()]) if (at >= cut) this.children.delete(at);
    if (this.harness === 'claude') this.claudeParent.uuid = this.units.length ? (JSON.parse(this.units.at(-1)!) as { uuid: string }).uuid : null;
    if (this.harness === 'hermes') {
      const ids = this.db!.prepare('select id from messages order by id').all() as Array<{ id: number }>;
      for (const { id } of ids.slice(cut)) this.db!.prepare('delete from messages where id = ?').run(id);
      this.written = cut;
      return;
    }
    await this.writeUpTo(cut);
  }

  /** Another record under the same name. */
  async replace(): Promise<void> {
    this.units = this.harness === 'codex' ? this.units.slice(0, 1) : [];
    this.turnUnits = [];
    this.children.clear();
    this.claudeParent.uuid = null;
    if (this.harness === 'hermes') { this.db!.prepare('delete from messages').run(); this.written = 0; return; }
    await this.writeUpTo(this.units.length);
  }

  async archive(): Promise<void> {
    if (this.archived || this.written === 0) return;
    await writeFile(`${this.path}.zst`, zstdCompressSync(await readFile(this.path)));
    await rm(this.path);
    this.archived = true;
  }

  /** The record as it is now (decoded), to tell whether a picture is still in it. */
  async text(): Promise<string> {
    if (this.harness === 'hermes') return '';
    const bytes = this.archived ? zstdDecompressSync(await readFile(`${this.path}.zst`)) : await readFile(this.path).catch(() => Buffer.alloc(0));
    return bytes.toString('latin1');
  }

  get length(): number { return this.units.length; }
  close(): void { this.db?.close(); }
}

// ─── the two fills ───────────────────────────────────────────────────────────────────────────────────────────────────

/** dev's fill (7a2a1343c): the whole record into one timeline, then the store's tail matched against all of it. */
async function oracleFill(sessionId: string): Promise<void> {
  const row = state.rows.get(sessionId)!;
  const identity = recordIdentityFor(row.provider)!;
  await withStoredTurns(sessionId, async () => {
    const unfinished = await readUnfinishedRecordTurnsNow(sessionId);
    // A fork: the parent's lineage first; the child is read after the prefix it proves (dev's `afterForkOf`).
    let parentLineage: readonly RecordLineageNode[] | undefined;
    const parentId = row.config?.forkedFrom.sessionId;
    if (parentId) {
      const parentRow = state.rows.get(parentId)!;
      const parent = await createSessionTimeline(createSessionRecordSource(
        { harness: 'claude', providerSessionId: parentRow.providerSessionId, roots: [state.root] }, { readMode: 'snapshot' }), { sessionId: parentId });
      parentLineage = parent.getRecordLineage?.() ?? undefined;
      parent.dispose();
      if (!parentLineage?.length) return;
    }
    let record: TranscriptTurn[];
    try {
      const timeline = await createSessionTimeline(createSessionRecordSource(
        { harness: row.provider as Harness, providerSessionId: row.providerSessionId, roots: [state.root] }, { readMode: 'snapshot', ...(parentLineage ? { parentLineage } : {}) }), { sessionId });
      record = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
      timeline.dispose();
    } catch (error) {
      // No record, or one that no longer extends its parent: nothing to fill (dev's `unavailable` / `diverged`).
      if ((error as Error).name === 'SessionRecordForkDivergedError' || (error as Error).name === 'SessionRecordNotFoundError') return;
      throw error;
    }
    if (record.length === 0) return;
    let missing: TranscriptTurn[] | null = null;
    for (const limit of identity === 'content' ? [10, 50, 200, Number.MAX_SAFE_INTEGER] : [10, 50, 200]) {
      const tail = await readStoredTailNow(sessionId, limit);
      missing = recordTurnsAfterStore(record, tail, identity, { hasOlderStoredTurns: tail.length === limit, hermesPromptReceipts: row.provider === 'hermes' });
      if (missing !== null || tail.length < limit) break;
    }
    if (missing === null) return;
    const revisions = new Map<string, number>();
    const revised: TranscriptTurn[] = [];
    for (const turn of record) {
      const matches = unfinished.filter(stored => recordTurnsAfterStore([turn], [stored], identity)?.length === 0);
      if (matches.length > 1) return;
      if (matches.length === 0) continue;
      revisions.set(turn.id, matches[0].seq);
      revised.push(turn);
    }
    for (const turn of [...revised, ...missing]) {
      const seq = revisions.get(turn.id);
      if (seq !== undefined) reviseRecordTurnNow(sessionId, seq, turn);
      else appendRecordTurnNow(sessionId, turn);
    }
  });
}

/** dev's received deliveries: every delivery id in the record's user messages. */
async function oracleDeliveries(harness: Harness): Promise<string[] | null> {
  const timeline = await createSessionTimeline(createSessionRecordSource(
    { harness, providerSessionId: harness === 'codex' ? THREAD : harness === 'claude' ? CLAUDE : HERMES, roots: [state.root] }, { readMode: 'snapshot' }), { sessionId: 'oracle' })
    .catch((error: Error) => { if (error.name === 'SessionRecordNotFoundError') return null; throw error; });
  // No record: dev answered null (unknown), and the agent replays.
  if (!timeline) return null;
  const ids = new Set<string>();
  for (const turn of timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns) {
    for (const item of turn.items) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) if (segment.facts?.messageId) ids.add(segment.facts.messageId);
    }
  }
  timeline.dispose();
  return [...ids];
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fresh: Fixture, before: Fixture;
beforeAll(async () => {
  fresh = await openFixture('empty'); before = await openFixture('empty');
  for (const fixture of [fresh, before]) fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p1','P','/repo')");
});
let runs = 0;
afterAll(() => { fresh.close(); before.close(); });

/** A row, comparable across the two stores: its session prefix dropped, each picture as its type, length and bytes. */
async function comparable(fixture: Fixture, sessionId: string): Promise<unknown[]> {
  state.db = fixture.db;
  const rows = fixture.sqlite.prepare('SELECT seq, turn_id, data FROM session_turns WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ seq: number; turn_id: string; data: string }>;
  const out: unknown[] = [];
  for (const row of rows) {
    const turn = JSON.parse(row.data.split(`${sessionId}:`).join('S:')) as TranscriptTurn;
    const pictures: unknown[] = [];
    const visit = async (items: TranscriptTurn['items']) => {
      for (const item of items) {
        const node = item as unknown as { id: string; images?: Array<{ mimeType: string; data: string }>; imageRefs?: Array<{ mimeType: string; chars: number; record?: unknown }>; children?: TranscriptTurn['items'] };
        for (const [index, image] of (node.images ?? []).entries()) pictures.push([index, image.mimeType, image.data.length, image.data, undefined]);
        for (const [index, ref] of (node.imageRefs ?? []).entries()) {
          const found = await getStoredToolImage({ sessionId, seq: row.seq, itemId: node.id.split('S:').join(`${sessionId}:`), index });
          pictures.push([index, ref.mimeType, ref.chars, found.ok ? found.image.data : null, (ref.record as { start: number } | undefined)?.start]);
        }
        delete node.images; delete node.imageRefs;
        if (node.children) await visit(node.children);
      }
    };
    await visit(turn.items);
    out.push({ turn, pictures });
  }
  return out;
}

/** Equal, or an error that shows where the two first differ. */
function same(got: unknown, want: unknown, label: string): void {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g === w) return;
  let at = 0;
  while (at < g.length && g[at] === w[at]) at++;
  throw new Error(`${label} differs at ${at}:\n  fill:  …${g.slice(Math.max(0, at - 300), at + 300)}\n  whole: …${w.slice(Math.max(0, at - 300), at + 300)}`);
}

async function runCase(test: Case): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'resume-prop-'));
  const record = new RecordFile(test.harness, root, test.fork);
  runs++;
  const [a, b] = [`a${runs}`, `b${runs}`];
  try {
    await record.init();
    // A Hermes locator names the database itself.
    state.root = test.harness === 'hermes' ? record.path : root;
    const row = (): Row => ({ runtime: 'pty', provider: test.harness, providerSessionId: test.harness === 'codex' ? THREAD : test.harness === 'claude' ? CLAUDE : HERMES, agentStatus: 'idle', archivedAt: null, config: undefined });
    const parent = `p${runs}`;
    if (test.fork) state.rows.set(parent, { ...row(), providerSessionId: PARENT });
    const fork = test.fork ? { forkedFrom: { sessionId: parent } } : undefined;
    state.rows.set(a, { ...row(), config: fork }); state.rows.set(b, { ...row(), config: fork });
    for (const fixture of [fresh, before]) fixture.sqlite.prepare("INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES (?, 'p1', 'C', 'pty', 'idle')").run(fixture === fresh ? a : b);
    const r = random(test.seed ^ 0x9e3779b9);
    const step = async (label: string) => {
      state.db = fresh.db; await syncStoredHistoryFromRecord(a, { runtime: 'pty' });
      state.db = before.db; await oracleFill(b);
      const [got, want] = [await comparable(fresh, a), await comparable(before, b)];
      // A filled-in picture is read back from the record: one the record no longer holds (rewound, replaced) shows its
      // size only, where the whole-record fill kept the bytes (EQUIVALENCE.md, the one semantic difference).
      const now = await record.text();
      for (const row of want as Array<{ pictures?: unknown[][] }>) for (const picture of row.pictures ?? []) picture.pop();
      (got as Array<{ pictures?: unknown[][] }>).forEach((row, i) => row.pictures?.forEach((picture, j) => {
        const theirs = (want as Array<{ pictures?: unknown[][] }>)[i]?.pictures?.[j];
        const start = picture.pop() as number | undefined;
        if (picture[3] === null && typeof theirs?.[3] === 'string' && start !== undefined
          && now.slice(start, start + theirs[3].length) !== theirs[3]) theirs[3] = null;
      }));
      same(got, want, `${label}: store`);
      state.db = fresh.db;
      const received = (await recordedDeliveryIds(a))?.sort() ?? null;
      expect(received, `${label}: received deliveries`).toEqual((await oracleDeliveries(test.harness))?.sort() ?? null);
    };
    for (const [i, op] of test.ops.entries()) {
      if (op.kind === 'grow') {
        const start = record.length;
        record.add(op.turns);
        const cuts = [...new Set(Array.from({ length: op.cuts - 1 }, () => r.int(start + 1, record.length)))].sort((x, y) => x - y);
        for (const cut of [...cuts, record.length]) { await record.writeUpTo(cut); await step(`op ${i} grow to ${cut}`); }
      } else if (op.kind === 'rewind') { await record.rewind(op.keep); await step(`op ${i} rewind to ${op.keep}`); }
      else if (op.kind === 'replace') { await record.replace(); record.add(op.turns); await record.writeUpTo(record.length); await step(`op ${i} replace`); }
      else { await record.archive(); await step(`op ${i} archive`); }
    }
  } finally {
    record.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Smaller versions of a failing case: fewer ops, fewer turns per op, fewer cuts, no tools, no unfinished turn. */
function shrinks(test: Case): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < test.ops.length; i++) out.push({ ...test, ops: test.ops.filter((_, j) => j !== i) });
  test.ops.forEach((op, i) => {
    if (op.kind !== 'grow' && op.kind !== 'replace') return;
    const turns = op.turns;
    for (let k = 0; k < turns.length; k++) {
      if (turns.length > 1) out.push({ ...test, ops: test.ops.map((o, j) => j === i ? { ...op, turns: turns.filter((_, m) => m !== k) } : o) });
      if (turns[k].tool) out.push({ ...test, ops: test.ops.map((o, j) => j === i ? { ...op, turns: turns.map((t, m) => m === k ? { ...t, tool: undefined } : t) } : o) });
      if (turns[k].prompt.length > 20) out.push({ ...test, ops: test.ops.map((o, j) => j === i ? { ...op, turns: turns.map((t, m) => m === k ? { ...t, prompt: 'ok' } : t) } : o) });
    }
    if (op.kind === 'grow' && op.cuts > 1) out.push({ ...test, ops: test.ops.map((o, j) => j === i ? { ...op, cuts: op.cuts - 1 } : o) });
  });
  return out;
}

async function failure(test: Case): Promise<Error | null> {
  try { await runCase(test); return null; } catch (error) { return error as Error; }
}

it('fills the same store and answers the same deliveries as a whole-record fill, on random records', async () => {
  const samples = Number(process.env.RESUME_PROPERTY_SAMPLES ?? 120);
  const first = Number(process.env.RESUME_PROPERTY_SEED ?? 1);
  const counts: Record<string, number> = {};
  // `RESUME_PROPERTY_CASE` replays one reported case (envelope prompts as `<envelope:N>`).
  const replay = process.env.RESUME_PROPERTY_CASE
    ? JSON.parse(process.env.RESUME_PROPERTY_CASE.replace(/"<envelope:(\d)>"/g, (_, n: string) => JSON.stringify(envelope(DELIVERED[Number(n)])))) as Case : null;
  for (let seed = first; seed < first + (replay ? 1 : samples); seed++) {
    const test = replay ?? randomCase(seed);
    let error = await failure(test);
    if (!error) {
      counts[test.harness] = (counts[test.harness] ?? 0) + 1;
      if (test.fork) counts.fork = (counts.fork ?? 0) + 1;
      const subagents = test.ops.flatMap((op) => 'turns' in op ? op.turns : []).filter((turn) => turn.sub).length;
      if (subagents) { counts.withSubagents = (counts.withSubagents ?? 0) + 1; counts.subagents = (counts.subagents ?? 0) + subagents; }
      for (const op of test.ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
      continue;
    }
    // Shrink greedily: keep the first smaller case that still fails.
    let smallest = test;
    for (let progress = true; progress;) {
      progress = false;
      for (const candidate of shrinks(smallest)) {
        const found = await failure(candidate);
        if (found) { smallest = candidate; error = found; progress = true; break; }
      }
    }
    throw new Error(`seed ${seed} fails; smallest case: ${JSON.stringify(smallest, (k, v) => k === 'prompt' && v.length > 20 ? `<envelope:${DELIVERED.findIndex(id => v === envelope(id))}>` : v)}\n${error.message}\n${(error as { diff?: string }).diff ?? ''}`);
  }
  // A large run's readings (sample mix), for its report: `RESUME_PROPERTY_REPORT=<file>`.
  if (process.env.RESUME_PROPERTY_REPORT) await writeFile(process.env.RESUME_PROPERTY_REPORT, `${JSON.stringify({ samples, first, ...counts })}\n`);
}, 3_600_000);
