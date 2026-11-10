import type { TranscriptTurn } from '@gugu/session-core/acp';
import { indexHermesPrompts, originalHermesPrompt, type HermesPromptIndex } from '@gugu/session-core/acp/hermes-prompt';

/**
 * 认「库里这一轮 = 记录里那一轮」靠什么,按记录的格式分:
 * - `ids`:Claude 的记录里存的就是 Claude 自己发的编号(消息 id、工具调用 id),与运行时落库的同一套。
 * - `content`:Codex 的记录读取器按行号给条目编号,运行时落库的是 app-server 的条目 id、工具调用也是另一套
 *   (`exec-…` 对 `call_…`)⇒ 编号永远对不上,只能按内容认:人说的那句 + agent 最后回的那句。
 * - Hermes 的记录用 SQLite 行号(`hermes:<id>#0`),实时文本没消息编号,旧回放又用 `hermes-row-<id>` ⇒ 同样按内容认。
 *
 * 只有这三家接回时不重放、历史以记录为准;其余几家照旧重放,这里给 `null`(不补)。
 */
export type RecordIdentity = 'ids' | 'content';

export function recordIdentityFor(harness: string | null | undefined): RecordIdentity | null {
  if (harness === 'claude') return 'ids';
  if (harness === 'codex' || harness === 'hermes') return 'content';
  return null;
}

/**
 * 一轮里 agent 自己发的编号:provider 的消息 id、工具调用 id。条目 id 是 `${回合 id}:message:${消息 id}`,
 * 回合 id 在库里重编号过、在记录里另有一套,只认 `:turn:<序号>:` 之后那一截。归约器合成的(`auto:`)不是身份。
 */
export function turnIdentityKeys(turn: TranscriptTurn): Set<string> {
  const keys = new Set<string>();
  const visit = (item: { kind?: string; id?: string; role?: string; _meta?: Record<string, unknown>; toolCallId?: string; children?: unknown[] }) => {
    if (item.toolCallId) keys.add(`tool:${item.toolCallId}`);
    if ((item.kind === 'message' || item.kind === 'thinking') && item.id) {
      const native = item.role === 'user' ? item._meta?.guguNativeMessageId : undefined;
      const own = typeof native === 'string' ? native : /:turn:[^:]+:(?:message|thinking):(.+)$/.exec(item.id)?.[1];
      if (own && !own.startsWith('auto:')) keys.add(`message:${own}`);
    }
    for (const child of item.children ?? []) visit(child as typeof item);
  };
  for (const item of turn.items) visit(item as Parameters<typeof visit>[0]);
  return keys;
}

const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 人说的完整原文;仅 Hermes 原生全文有宿主摘要凭据时还原当时正文,不按标签猜。 */
export function turnPrompt(turn: TranscriptTurn, hermes?: HermesPromptIndex): string | null {
  const user = turn.items.find((item) => item.kind === 'message' && item.role === 'user');
  const text = user && 'text' in user ? squeeze(hermes ? originalHermesPrompt(user.text, hermes) ?? user.text : user.text) : '';
  return text || null;
}

/** 问答成对的指纹:人说的那句 + agent 最后回的那句。只有一边(只调了工具、没说话)= null。 */
export function turnFingerprint(turn: TranscriptTurn, hermes?: HermesPromptIndex): string | null {
  const prompt = turnPrompt(turn, hermes);
  const replies = turn.items.filter((item) => item.kind === 'message' && item.role === 'assistant' && 'text' in item && item.text.trim());
  const reply = replies.at(-1);
  if (!prompt || !reply || !('text' in reply)) return null;
  return JSON.stringify([prompt, squeeze(reply.text)]);
}

export type Identity = { keys: Set<string>; fingerprint: string | null; prompt: string | null };

export const identify = (turn: TranscriptTurn, hermes?: HermesPromptIndex): Identity =>
  ({ keys: turnIdentityKeys(turn), fingerprint: turnFingerprint(turn, hermes), prompt: turnPrompt(turn, hermes) });

/**
 * The same identity with every string replaced by a short digest: matching only compares for equality, so the ingest
 * child can keep one per record turn of a multi-GiB record (resume-mem).
 */
export function hashIdentity(identity: Identity, digest: (text: string) => string): Identity {
  return {
    keys: new Set([...identity.keys].map(digest)),
    fingerprint: identity.fingerprint === null ? null : digest(identity.fingerprint),
    prompt: identity.prompt === null ? null : digest(identity.prompt),
  };
}

/** 拿来定位的认法:只认确定的身份 —— 编号,或问答成对的指纹。光凭提问原文不定位:「继续」会重复。 */
function anchors(a: Identity, b: Identity, mode: RecordIdentity): boolean {
  if (mode === 'ids') return [...a.keys].some((key) => b.keys.has(key));
  return a.fingerprint !== null && a.fingerprint === b.fingerprint;
}

/** 排除用的认法,宽一档:锚点之后、库里已有的那几轮(失败的、只说了话的)可能连编号都没有,只剩提问原文。 */
function sameTurn(a: Identity, b: Identity, mode: RecordIdentity): boolean {
  if (anchors(a, b, mode)) return true;
  if (mode === 'ids' && a.keys.size > 0 && b.keys.size > 0) return false;
  return a.prompt !== null && a.prompt === b.prompt;
}

/** 完整内容也会重复:从唯一锚点(或完整库的开头)按已入库回合逐次往后认,不能跳到最后一处。 */
function contentTail(seen: Identity[], stored: Identity[], hasOlderStoredTurns: boolean): { from: number; anchor: Anchor } | null {
  const locations = new Map<string, number[]>();
  const prompts = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string | null, at: number) => {
    if (key === null) return;
    const previous = map.get(key);
    if (previous) previous.push(at);
    else map.set(key, [at]);
  };
  seen.forEach((one, at) => { add(locations, one.fingerprint, at); add(prompts, one.prompt, at); });
  const chronological = stored.toReversed();
  let start = -1, at = -1;
  for (let index = chronological.length - 1; index >= 0; index--) {
    const key = chronological[index].fingerprint;
    const matches = key === null ? undefined : locations.get(key);
    if (matches?.length === 1) { start = index; at = matches[0]; break; }
  }
  if (start < 0) {
    // 只拿到库尾、候选又有重复 ⇒ 让调用者多读旧行,不能把这一页当整份历史。
    if (hasOlderStoredTurns) return null;
    for (let index = 0; index < chronological.length; index++) {
      const key = chronological[index].fingerprint;
      const matches = key === null ? undefined : locations.get(key);
      if (matches?.length) { start = index; at = matches[0]; break; }
    }
  }
  if (start < 0) return null;
  let anchored = start;
  for (let index = start + 1; index < chronological.length; index += 1) {
    const one = chronological[index];
    const matches = one.fingerprint !== null ? locations.get(one.fingerprint) : one.prompt !== null ? prompts.get(one.prompt) : undefined;
    // 相同问答可能有成千上万轮,按有序位置二分,不反复扫描已认过的前缀。
    let low = 0, high = matches?.length ?? 0;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (matches![mid] <= at) low = mid + 1;
      else high = mid;
    }
    if (matches && low < matches.length) { at = matches[low]; anchored = index; }
  }
  return { from: at + 1, anchor: { seen: at, stored: chronological.length - 1 - anchored } };
}

/** A record turn and the stored row (index newest first) it was recognized as. */
export type Anchor = { seen: number; stored: number };

/**
 * 记录里接在库尾之后、库里还没有的那几轮,由旧到新。`storedNewestFirst` 是库尾那几行,由新到旧。
 *
 * 编号模式从库尾往旧找强身份锚点;内容模式按已有回合顺序对齐,重复问答按出现次数消耗。锚点之后的都要补,
 * 只除掉库里比锚点还新、记录里却没认出来的那几行(失败的、没进记录的)—— 每行只抵一次,重复的「继续」不会被一并吞掉。
 *
 * - 库是空的 ⇒ 整份记录都要补。
 * - 库尾一行都认不出 ⇒ `null`:记录与库已经岔开(换了记录、被改写过),❌ 把整份记录接在后面。
 * - 按编号认、库尾却一个编号都没有(全是只说话的轮)⇒ 这一次按问答指纹认。
 */
export function recordTurnsAfterStore(
  record: readonly TranscriptTurn[],
  storedNewestFirst: readonly TranscriptTurn[],
  identity: RecordIdentity = 'ids',
  options: { hasOlderStoredTurns?: boolean; hermesPromptReceipts?: boolean } = {},
): TranscriptTurn[] | null {
  if (storedNewestFirst.length === 0) return [...record];
  const stored = storedNewestFirst.map((turn) => identify(turn));
  const hermes = options.hermesPromptReceipts ? indexHermesPrompts(storedNewestFirst.flatMap((turn) => turn.items)) : undefined;
  if (hermes && record.some((turn) => turn.items.some((item) => item.kind === 'message' && item.role === 'user'
    && originalHermesPrompt(item.text, hermes) === null))) return null;
  const picked = matchAfterStore(record.map((turn) => identify(turn, hermes)), stored, identity, options);
  return picked === null ? null : picked.map((index) => record[index]);
}

/**
 * `recordTurnsAfterStore` on identities alone: the indexes of the record turns to add, oldest first, or `null` when the
 * store and the record diverged. The ingest child runs it over hashed identities (`hashIdentity`).
 */
export function matchAfterStore(
  seen: readonly Identity[],
  stored: readonly Identity[],
  identity: RecordIdentity,
  options: { hasOlderStoredTurns?: boolean } = {},
): number[] | null {
  return matchAfterStoreAt(seen, stored, identity, options)?.missing ?? null;
}

/** `matchAfterStore`, with the newest record turn it recognized as a stored row (null when the store is empty). */
export function matchAfterStoreAt(
  seen: readonly Identity[],
  stored: readonly Identity[],
  identity: RecordIdentity,
  options: { hasOlderStoredTurns?: boolean } = {},
): { missing: number[]; anchor: Anchor | null } | null {
  const all = (from: number) => Array.from({ length: Math.max(0, seen.length - from) }, (_, offset) => from + offset);
  if (stored.length === 0) return { missing: all(0), anchor: null };
  const mode: RecordIdentity = identity === 'ids' && stored.every((one) => one.keys.size === 0) ? 'content' : identity;
  if (mode === 'content') {
    const tail = contentTail([...seen], [...stored], options.hasOlderStoredTurns ?? false);
    return tail === null ? null : { missing: all(tail.from), anchor: tail.anchor };
  }
  for (let newer = 0; newer < stored.length; newer += 1) {
    let at = -1;
    for (let index = seen.length - 1; index >= 0; index -= 1) {
      if (anchors(seen[index], stored[newer], mode)) {
        at = index;
        break;
      }
    }
    if (at < 0) continue;
    const unrecognized = stored.slice(0, newer);
    return { anchor: { seen: at, stored: newer }, missing: all(at + 1).filter((index) => {
      const hit = unrecognized.findIndex((one) => sameTurn(seen[index], one, mode));
      if (hit < 0) return true;
      unrecognized.splice(hit, 1);
      return false;
    }) };
  }
  return null;
}
