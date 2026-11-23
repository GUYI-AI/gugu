import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { codexFilePatches } from '../../acp/transport/codex-file-patches';
import { codexMcpCall } from '../../acp/transport/codex-mcp-call';
import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import { readCodexRecord, type CodexRecord, type CodexRecordItem } from '@gugu/core/local/agent/transcriptSources/codex';

import type { RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { createJsonlTailSource } from './jsonl-tail-source';
import { RECORD_START } from './record-tree';
import { openWindowByteSource } from '../window-cache/file-source';
import { childState, withSubagentSources } from './subagent-sources';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  parseTimestamp,
  type SessionRecordSourceOptions,
  toolCallResult,
  toolCallStart,
  toolKindTable
} from './shared';


/** 目录并发下钻宽度。codex 按 年/月/日 分层，一台常用机上有几千个日期目录(本机实测 34882 份 rollout)。 */
const DIR_CONCURRENCY = 16;

/**
 * 一条记录在链上的位置。
 *
 * key 用**序号**而不是 codex 自己的 id:`--resume` 后 codex 会把 item id 重编号，
 * 拿它当身份键会让同一件事在恢复前后各算一次(历史直接翻倍)。序号只由「这份文件从头数到这里」
 * 决定，同一份文件读多少遍都一样;续读时随续读点装回去，接着数。
 */
type Child = { id: string; name: string; callId: string; task?: string; model?: string };
type Ordinals = {
  turn: number; item: number; userSeen: boolean; calls: Record<string, Record<string, unknown>>; children: Record<string, Child>;
  /** The previous line on the chain, and the turns still in the thread: each turn's first line and the line before it. */
  last: string; turns: Array<{ id: string; parent: string }>;
  /** The running turn's own id (`task_started.turn_id`), null when its line has none. */
  turnId: string | null;
};

const initialOrdinals = (): Ordinals => ({ turn: 0, item: -1, userSeen: false, calls: {}, children: {}, last: RECORD_START, turns: [], turnId: null });

export function createCodexJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions, nativeChild = false, ancestors: ReadonlySet<string> = new Set()): SessionRecordSource {
  const lineage = new Set(ancestors);
  lineage.add(locator.providerSessionId);
  const root = createJsonlTailSource<Ordinals>(locator, options, {
    name: 'codex',
    // 11: a fork reads its parent's prefix (history_base in a plainly named rollout); state saved before that never did.
    resumeVersion: 11,
    resolve: () => resolveRolloutFile(locator, options?.readMode === 'snapshot'),
    continuesElsewhere: true,
    prefixes: (path) => rolloutPrefixes(locator, path),
    initial: () => initialOrdinals(),
    // `calls`, `children` and `turns` are replaced, never changed in place: a snapshot need not copy them.
    snapshot: (ordinals) => ({ ...ordinals }),
    childIds: (ordinals) => Object.keys(ordinals.children),
    node(record, ordinals) {
      // 序号按**每一条记录**推进，不按「解出了 event 的记录」推进:
      // 这样以后给某个记录类型补上解码，已有 key 不会整体错位。回退掉的行也照样数。
      const codex = readCodexRecord(record);
      ordinals.item += 1;
      if (codex.turnStart) {
        ordinals.turn += 1;
        ordinals.item = 0;
      }
      const id = `${ordinals.turn}:${ordinals.item}`;
      const parent = ordinals.last;
      ordinals.last = id;
      const rollback = rolledBackTurns(record);
      if (rollback !== null) {
        const back = rollBack(ordinals, rollback);
        return { id, parent: back === undefined ? parent : back, kind: 'rewind' };
      }
      if (!codex.turnStart) return { id, parent, kind: 'line' };
      ordinals.turns = [...ordinals.turns, { id, parent }];
      const turnId = asRecord(record.payload)?.turn_id;
      ordinals.turnId = typeof turnId === 'string' && turnId ? turnId : null;
      return { id, parent, kind: 'prompt' };
    },
    decode(record, ordinals) {
      const codex = readCodexRecord(record);
      if (codex.turnStart || codex.end) ordinals.userSeen = false;
      const key = `codex:${locator.providerSessionId}:${ordinals.turn}:${ordinals.item}`;
      if (rolledBackTurns(record) !== null) return [];
      if (nativeChild && codex.turnStart) return [{ key, at: parseTimestamp(codex.timestamp), event: childState(locator.providerSessionId, 'in_progress') }];
      const item = codex.item;
      if (item?.kind === 'tool_call' && item.namespace === 'collaboration') {
        let input = item.input;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
        if (asRecord(input)) ordinals.calls = { ...ordinals.calls, [item.id]: { ...asRecord(input), name: item.name } };
        return [];
      }
      if (item?.kind === 'tool_result' && ordinals.calls[item.callId]) return [];
      if (item?.kind === 'subagent') {
        // Native peer activity may point back to this record or one of its ancestors.
        if (lineage.has(item.threadId)) return [];
        const input = ordinals.calls[item.id] ?? {};
        const child = ordinals.children[item.threadId] ?? {
          id: item.threadId, name: item.name, callId: item.id,
          ...(typeof input.message === 'string' ? { task: input.message } : {}),
          ...(typeof input.model === 'string' ? { model: input.model } : {}),
        };
        const first = !ordinals.children[item.threadId];
        ordinals.children = { ...ordinals.children, [item.threadId]: child };
        const at = parseTimestamp(codex.timestamp);
        // The child's own record updates its card; the root's `completed` / `interrupted` activity is the row saying it
        // ended, in the root turn that was running when it did (a completed child's text arrives with its FINAL_ANSWER,
        // below). Codex notes no other ending in the parent's record: a child whose turn failed shows that on its card.
        const ended = item.activity === 'completed' ? 'completed' : item.activity === 'interrupted' ? 'stopped' : null;
        const done: RecordEntry[] = ended
          ? [{ key, at, event: { kind: 'subagent_done', parentRecord: true, toolCallId: child.id, agentId: child.id, status: ended } }] : [];
        if (!first) return done;
        return [{ key: `${key}#0`, at, event: {
          kind: 'subagent', toolCallId: child.id, subagentSessionId: child.id,
          ...(child.name ? { title: child.name } : {}),
          ...((child.task ?? child.name) ? { inputSummary: child.task ?? child.name } : {}),
          status: 'completed', parentToolCallId: null, canCancel: false, background: true,
          ...(child.model ? { model: child.model } : {}),
          ...(child.callId ? { agentToolUseId: child.callId } : {}),
          ...(child.task ? { rawInput: child.task } : {}),
        } }, ...done];
      }
      const answer = finalAnswer(record, ordinals.children);
      if (answer) return [{ key, at: parseTimestamp(codex.timestamp), event: {
        kind: 'subagent_done', parentRecord: true, toolCallId: answer.child.id, agentId: answer.child.id, status: 'completed', outputText: answer.text } }];
      const entry = decode(codex, key);
      const event = entry?.event;
      if (entry && event?.kind === 'message' && event.role === 'user') {
        // Only task_started's leading input opens a turn; later inputs continue it.
        const steering = ordinals.turn > 0 && ordinals.userSeen;
        ordinals.userSeen = true;
        if (steering) return [{ key: entry.key, at: entry.at, event: { ...event, steering: true } }];
        // The leading input carries the point a revert steps back to, as its live receipt did: the Codex bridge
        // reverts to before a turn by its id.
        if (ordinals.turnId) return [{ key: entry.key, at: entry.at, event: { ...event, revertAnchor: ordinals.turnId } }];
      }
      return entry ? [entry] : [];
    }
  });
  return withSubagentSources(
    root,
    // A child's pictures are in its own file: a place kept for them would point into the root record.
    (id) => createCodexJsonlSource({ ...locator, providerSessionId: id }, options && { ...options, fill: undefined }, true, lineage),
    () => createCodexJsonlSource(locator, options, nativeChild, ancestors),
    options,
  );
}

/** `num_turns` of a `thread_rolled_back` line, or null for any other line. */
function rolledBackTurns(record: Record<string, unknown>): number | null {
  const payload = asRecord(record.payload);
  return record.type === 'event_msg' && payload?.type === 'thread_rolled_back' && typeof payload.num_turns === 'number' ? payload.num_turns : null;
}

/**
 * Codex's thread history drops the last `count` turns still in it, the running one included; a turn is what a
 * `task_started` opened, kept even when empty (app-server `ThreadHistoryBuilder::handle_thread_rollback`). The rolled
 * back turns stay in the file: the rollback line hangs off the line before the first of them, which makes them an
 * abandoned branch (`record-tree.ts`). Undefined = nothing to take back.
 */
function rollBack(ordinals: Ordinals, count: number): string | undefined {
  if (count <= 0 || ordinals.turns.length === 0) return undefined;
  const kept = ordinals.turns.slice(0, Math.max(0, ordinals.turns.length - count));
  const first = ordinals.turns[kept.length]!;
  ordinals.turns = kept;
  return first.parent;
}

/** A child's final answer, which Codex hands to its parent as an `agent_message` in the parent's record:
 * `Message Type: FINAL_ANSWER` … `Payload:` and the child's reply. */
function finalAnswer(record: Record<string, unknown>, children: Record<string, Child>): { child: Child; text: string } | null {
  const payload = asRecord(record.payload);
  if (record.type !== 'response_item' || payload?.type !== 'agent_message' || typeof payload.author !== 'string') return null;
  // A path names one live agent at a time (Codex refuses a second live one), so the latest child with it is the sender.
  const child = Object.values(children).findLast((candidate) => candidate.name === payload.author);
  if (!child || !Array.isArray(payload.content)) return null;
  const text = payload.content.map((part) => asRecord(part)?.text).filter((part): part is string => typeof part === 'string').join('');
  const reply = /^Message Type: FINAL_ANSWER\n[\s\S]*?\nPayload:\n([\s\S]*)$/.exec(text)?.[1];
  return reply === undefined ? null : { child, text: reply };
}

/** Decode one already-budgeted window record with its real source-anchor key, without prefix ordinals/state. */
export function decodeCodexWindowRecord(record: Record<string, unknown>, key: string, steering = false): RecordEntry[] {
  const codex = readCodexRecord(record);
  if (codex.item?.kind === 'subagent') {
    const item = codex.item;
    return [{ key, at: parseTimestamp(codex.timestamp), event: {
      kind: 'subagent', toolCallId: item.threadId, subagentSessionId: item.threadId,
      title: item.name, status: 'completed', parentToolCallId: null, canCancel: false,
      background: true, agentToolUseId: item.id,
    } }];
  }
  const entry = decode(codex, key);
  if (entry && entry.event?.kind === 'message' && entry.event.role === 'user' && steering) {
    return [{ key: entry.key, at: entry.at, event: { ...entry.event, steering: true } }];
  }
  return entry ? [entry] : [];
}

function decode(record: CodexRecord, key: string): RecordEntry | null {
  const at = parseTimestamp(record.timestamp);
  if (record.end) {
    return boundaryEntry(
      key,
      at,
      record.end === 'aborted'
        ? { kind: 'turn_aborted' }
        : record.end === 'failed'
          ? { kind: 'turn_failed' }
          : { kind: 'turn_end', stopReason: 'end_turn' }
    );
  }
  if (!record.item) return null;
  return { key, ...(at !== undefined ? { at } : {}), event: toEvent(record.item, key) };
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

/**
 * Find the newest rollout, including `-<threadId>_<segmentId>.jsonl` continuations across date directories.
 *
 * 日期目录并发下钻的做法照抄 `packages/core/src/local/agent/transcriptInventory.ts`：
 * 串行递归光 readdir 就要几秒，那是"打开会话"这件事最大的一块墙钟。
 */
export async function resolveRolloutFile(locator: SessionRecordLocator, snapshot: boolean): Promise<string> {
  const suffix = `-${locator.providerSessionId}.jsonl`;
  // Prefer the live file across all roots. Only a historical read may open an archive.
  for (const extension of snapshot ? ['.jsonl', '.jsonl.zst'] : ['.jsonl']) {
    let newest: string | null = null;
    for (const root of locator.roots) {
      const hit = await findRollout(root, name => {
        if (!name.endsWith(extension)) return false;
        const stem = name.slice(0, -extension.length);
        return stem.endsWith(`-${locator.providerSessionId}`) || stem.endsWith(`_${locator.providerSessionId}`)
          || stem.includes(`-${locator.providerSessionId}_`);
      });
      if (hit && (!newest || basename(hit) > basename(newest))) newest = hit;
    }
    if (newest) return newest;
  }
  throw new SessionRecordNotFoundError(
    `找不到 codex rollout 记录：threadId=${locator.providerSessionId}`,
    locator.roots.map((root) => join(root, '**', `rollout-*${suffix.replace('.jsonl', '*.jsonl')}`))
  );
}

type RolloutPrefix = { path: string; endByteOffset: number };

/** Each history_base names one physical file; its ordinal is chain-global, its byte cutoff is file-local. */
async function rolloutPrefixes(locator: SessionRecordLocator, tail: string): Promise<RolloutPrefix[]> {
  const prefixes: RolloutPrefix[] = [];
  const seen = new Set<string>();
  for (let path = tail; ;) {
    if (seen.has(path)) throw new Error('Cyclic Codex history_base chain');
    seen.add(path);
    const base = await historyBase(path);
    if (!base) return prefixes.reverse();
    let parent: string | null = null;
    for (const root of locator.roots) {
      parent = await findRollout(root, name => name.endsWith(`-${base.threadId}.jsonl`) || name.endsWith(`_${base.threadId}.jsonl`));
      if (parent) break;
    }
    if (!parent) throw new SessionRecordNotFoundError(`Missing Codex history_base: ${base.threadId}`, locator.roots);
    prefixes.push({ path: parent, endByteOffset: base.endByteOffset });
    path = parent;
  }
}

/**
 * Only the first record is metadata. Never scan the rollout looking for a history_base. A segment
 * (`-<thread>_<segment>.jsonl`) continues its thread; a fork's own rollout, plainly named, continues its parent
 * (`forked_from_id`, history_base up to the fork point).
 */
async function historyBase(path: string): Promise<{ threadId: string; endByteOffset: number } | null> {
  if (path.endsWith('.zst')) {
    // Archives are read whole, unopened here; a compressed segment cannot be.
    if (basename(path).includes('_')) throw new Error('Compressed Codex history segments are not supported');
    return null;
  }
  const source = await openWindowByteSource(path);
  try {
    // Match the inventory's metadata-head bound; base_instructions can make this first line much larger than a page.
    const bytes = new Uint8Array(Math.min(1024 * 1024, (await source.snapshot()).size));
    let used = 0;
    while (used < bytes.length) {
      const got = await source.read(bytes, used, bytes.length - used, used);
      if (!got) break;
      used += got;
    }
    const end = bytes.subarray(0, used).indexOf(10);
    if (end < 0) {
      throw new Error('Incomplete or oversized Codex segment session_meta');
    }
    let record: Record<string, unknown> | null;
    try { record = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)))); }
    catch { throw new Error('Invalid Codex segment session_meta'); }
    const payload = asRecord(record?.payload);
    if (record?.type !== 'session_meta' || payload?.history_base == null) return null;
    const base = asRecord(payload.history_base);
    if (!base || typeof base.thread_id !== 'string' || !base.thread_id
      || !Number.isSafeInteger(base.end_byte_offset) || (base.end_byte_offset as number) < 0
      || !Number.isSafeInteger(base.end_ordinal_exclusive) || (base.end_ordinal_exclusive as number) < 0) {
      throw new Error('Invalid Codex history_base');
    }
    return { threadId: base.thread_id, endByteOffset: base.end_byte_offset as number };
  } finally { await source.close(); }
}

async function findRollout(root: string, matches: (name: string) => boolean): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null; // 这一家没装 / 根目录不在，不是错误
  }
  const subdirs: string[] = [];
  let found: string | null = null;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) subdirs.push(path);
    else if (entry.isFile() && entry.name.startsWith('rollout-') && matches(entry.name)
      && (!found || entry.name > basename(found))) found = path;
  }

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(DIR_CONCURRENCY, subdirs.length) }, async () => {
      while (cursor < subdirs.length) {
        const nested = await findRollout(subdirs[cursor++], matches);
        if (nested && (!found || basename(nested) > basename(found))) found = nested;
      }
    })
  );
  return found;
}

// ─── 映射 ────────────────────────────────────────────────────────────────────
// 一行记录是什么意思由 core 的 `readCodexRecord` 读（导入清单读的是同一份）；这里只解码成领域事件。

function toEvent(item: CodexRecordItem, messageId: string): NormalizedEvent {
  switch (item.kind) {
    case 'text':
      return item.text ? { kind: 'message', role: item.role, messageId, text: item.text } : { kind: 'ignored' };
    case 'thinking':
      return item.text ? { kind: 'thinking', messageId, text: item.text } : { kind: 'ignored' };
    case 'subagent':
      throw new Error('Codex subagent activity must be decoded with its source state');
    case 'file_change':
      return { ...toolCallResult(item.id, item.failed ? 'failed' : 'completed', { contentBlocks: codexFilePatches(item) }), title: 'apply_patch', toolKind: 'edit' };
    case 'tool_call':
      return toolCallStart(item.id, item.name, codexToolKind(item.name), item.input);
    case 'mcp_call': {
      // Read as the live bridge reads the same app-server item (codexMcpCall): a send's receipt is its text, and the task
      // page draws the sent message from it once the turn is read back from the record.
      const { name, rawInput, rawOutput, blocks } = codexMcpCall(item.call);
      const texts = blocks.flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []);
      const images = blocks.flatMap((block) => block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
        ? [{ mimeType: block.mimeType, data: block.data }] : []);
      return {
        ...toolCallResult(item.id, item.failed ? 'failed' : 'completed', {
          ...(texts.length ? { text: texts.join('\n') } : {}), images, rawInput, ...(rawOutput !== undefined ? { rawOutput } : {}),
        }),
        title: name, toolKind: 'other',
      };
    }
    case 'tool_result': {
      const text = typeof item.output === 'string' ? item.output : null;
      // An MCP tool's result is recorded as input items (`input_text`, `input_image`): its text and pictures go as ACP
      // content blocks, as the live ACP stream has them (148 10-14) — the card reads them there.
      const blocks = Array.isArray(item.output) ? item.output.flatMap(codexResultBlock) : [];
      // The output is held once: a result whose every item became a block is not kept again as rawOutput (6 MB of
      // pictures stored twice, review 10f3ea946c); one with an item no block carries stays disclosed whole, as the
      // claude source does (#6020).
      const carried = Array.isArray(item.output) && blocks.length > 0 && blocks.length === item.output.length;
      const texts = blocks.filter((block) => block.type === 'text').map((block) => block.text);
      return toolCallResult(item.callId, item.failed ? 'failed' : 'completed', {
        ...(text !== null ? { text } : texts.length ? { text: texts.join('\n') } : {}),
        images: blocks.filter((block) => block.type === 'image'),
        ...(item.output !== undefined && text === null && !carried ? { rawOutput: item.output } : {}),
      });
    }
  }
}

/** One recorded input item of a tool's result as an ACP content block: its text, or its picture (a `data:` URL). */
function codexResultBlock(item: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> {
  const record = asRecord(item);
  if (record?.type === 'input_text' && typeof record.text === 'string') return [{ type: 'text', text: record.text }];
  const url = record?.type === 'input_image' && typeof record.image_url === 'string' ? record.image_url : '';
  const picture = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return picture ? [{ type: 'image', mimeType: picture[1], data: picture[2] }] : [];
}

/** codex 的工具名 → ACP ToolKind。名单外一律 'other'，理由同 claude 侧。 */
const codexToolKind = toolKindTable({ execute: ['shell', 'local_shell', 'exec_command'], edit: ['apply_patch', 'write_file'], read: ['read_file'], fetch: ['web_search', 'web_fetch'] });
