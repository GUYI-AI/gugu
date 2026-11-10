import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { codexFilePatches } from '../../acp/transport/codex-file-patches';
import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import { readCodexRecord, type CodexRecord, type CodexRecordItem } from '@gugu/core/local/agent/transcriptSources/codex';

import type { RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { createJsonlTailSource } from './jsonl-tail-source';
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
type Ordinals = { turn: number; item: number; userSeen: boolean; calls: Record<string, Record<string, unknown>>; children: Record<string, Child> };

export function createCodexJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions, nativeChild = false): SessionRecordSource {
  const root = createJsonlTailSource<Ordinals>(locator, options, {
    name: 'codex',
    resumeVersion: 6,
    resolve: () => resolveRolloutFile(locator, options?.readMode === 'snapshot'),
    initial: () => ({ turn: 0, item: -1, userSeen: false, calls: {}, children: {} }),
    // `calls` and `children` are replaced, never changed in place: a snapshot need not copy them.
    snapshot: (ordinals) => ({ ...ordinals }),
    childIds: (ordinals) => Object.keys(ordinals.children),
    decode(record, ordinals) {
      const codex = readCodexRecord(record);
      // 序号按**每一条记录**推进，不按「解出了 event 的记录」推进:
      // 这样以后给某个记录类型补上解码，已有 key 不会整体错位。
      ordinals.item += 1;
      if (codex.turnStart) {
        ordinals.turn += 1;
        ordinals.item = 0;
      }
      if (codex.turnStart || codex.end) ordinals.userSeen = false;
      const key = `codex:${locator.providerSessionId}:${ordinals.turn}:${ordinals.item}`;
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
      }
      return entry ? [entry] : [];
    }
  });
  return withSubagentSources(
    root,
    // A child's pictures are in its own file: a place kept for them would point into the root record.
    (id) => createCodexJsonlSource({ ...locator, providerSessionId: id }, options && { ...options, fill: undefined }, true),
    () => createCodexJsonlSource(locator, options, nativeChild),
    options,
  );
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
 * 找 `<sessionRoot>/<年>/<月>/<日>/rollout-<时间戳>-<threadId>.jsonl`。
 *
 * 日期目录并发下钻的做法照抄 `packages/core/src/local/agent/transcriptInventory.ts`：
 * 串行递归光 readdir 就要几秒，那是"打开会话"这件事最大的一块墙钟。
 */
export async function resolveRolloutFile(locator: SessionRecordLocator, snapshot: boolean): Promise<string> {
  const suffix = `-${locator.providerSessionId}.jsonl`;
  // Prefer the live file across all roots. Only a historical read may open an archive.
  for (const extension of snapshot ? [suffix, `${suffix}.zst`] : [suffix]) {
    for (const root of locator.roots) {
      const hit = await findBySuffix(root, extension);
      if (hit) return hit;
    }
  }
  throw new SessionRecordNotFoundError(
    `找不到 codex rollout 记录：threadId=${locator.providerSessionId}`,
    locator.roots.map((root) => join(root, '**', `rollout-*${suffix}`))
  );
}

async function findBySuffix(root: string, suffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null; // 这一家没装 / 根目录不在，不是错误
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) subdirs.push(path);
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
      return path;
    }
  }

  let cursor = 0;
  let found: string | null = null;
  await Promise.all(
    Array.from({ length: Math.min(DIR_CONCURRENCY, subdirs.length) }, async () => {
      while (cursor < subdirs.length && !found) {
        const nested = await findBySuffix(subdirs[cursor++], suffix);
        if (nested) found = nested;
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
