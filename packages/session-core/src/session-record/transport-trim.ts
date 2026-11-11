import type { TerminalState, ToolImage, ToolImageRef, ToolNode, TranscriptItem, TranscriptTurn } from '../acp/client';
import { messageContentText } from '../acp/models/entity-content';
import { isGuguServer } from '../acp/models/turns/opened-outputs';
import { catalogCall, toolCallName } from '../acp/models/turns/tool-calls';
import { isQuestionOrPlanToolName } from './sources/question-tools';
import { deriveToolInputSummary } from './tool-input-summary';
import type {
  TimelineAfterResult,
  TimelineBatch,
  TimelineOlderResult,
  TimelineSnapshot,
  TurnPatch,
} from './contract';

/**
 * Phone and desktop transport projections share field trimming, lazy image references,
 * and a UTF-8 page budget. Raw records stay intact.
 *
 * trimmedChars makes shortened tool content visible to the reader. Omitted older
 * turns remain reachable through each API's existing exclusive cursor.
 * Unchanged objects retain their references on the streaming path.
 */

/** 单个字段的上限（字符）。8K 够看清一条命令的开头与大多数工具的全部输出。 */
export const TRANSPORT_TEXT_LIMIT = 8_192;

/** 会被裁的那些格子：工具调用带回来的大块文本。❌ 不裁用户自己写的消息。 */
const TRIMMED_FIELDS = ['outputText', 'rawOutput', 'rawInput', 'content'] as const;

/**
 * 工具交回来的图**不随记录走**:每张只留 `{ mimeType, chars }`(`imageRefs`),手机等那张图滚进视口、那一轮
 * 展开了,再按 (会话, 条目, 第几张) 去机器上取(`sessionTimeline.sessionToolImage`)。
 *
 * 为什么(owner 10-15「手机上看的话每张图传过去岂不是很 costly」,155 定):随记录下发时,app_check 的四张约
 * 120K 字跟着冷开那一份一起下来,可轮次默认是折叠的,人还没看见(2026-10-15 实抓手机流量)。
 * 图不算裁掉的字 —— 它没丢,取得到,❌ 记进 `trimmedChars`。
 */
function imageRefsOf(images: readonly ToolImage[]): ToolImageRef[] {
  return images.map((image) => ({ mimeType: image.mimeType, chars: image.data.length }));
}

const TRANSPORTED_BLOCKS = new Set(['diff', 'terminal']);

/**
 * @@@unshown-output — what a reader whose view shows no tool output gets of it: the opening, and no terminal capture
 * at all. The conversation view (the session page on a desktop and on a phone) draws a call as one line, what was
 * done and with what; its output and the terminal capture beside it appear nowhere. On a real 3055-turn conversation they are 14MB of the 50MB a
 * remote reader pages through. Such a reader asks for `lean` pages. A view that does show output (the full tool
 * rows) must not ask: it would show the opening with its "N characters omitted" note and have no way to the rest.
 */
export const HELD_PREVIEW_CHARS = 300;
const HELD_FIELDS: ReadonlySet<string> = new Set(['outputText', 'rawOutput']);
/** Gugu's own calls whose answer the conversation view reads: a send's receipt, what a tab opened, and a wrapped call. */
const READ_WHEN_FOLDED = /(?:^|__)(?:message_send|message_send_file|message_send_as_owner|widget_send|session_message|session_open_in_tab|catalog_call)$/;

/**
 * Whether the conversation view does without a call's output. Not when it reads or shows it: a call that did not
 * succeed (the output is its reason), a patch, a plan, a sub-agent's dispatch and its completion (the roster reads
 * them), a question put to the reader or a plan to approve (a card with its answer), and the Gugu calls above.
 */
function outputUnshown(node: ToolNode): boolean {
  if (node.kind === 'tool-group' || node.status !== 'done') return false;
  if (node.kind === 'patch-tool-call' || node.kind === 'create-plan-tool-call'
    || node.kind === 'spawn-subagent-tool-call' || node.kind === 'subagent-done-tool-call') return false;
  if (isQuestionOrPlanToolName(toolCallName(node))) return false;
  return !(node.kind === 'mcp-tool-call' && isGuguServer(node.server) && READ_WHEN_FOLDED.test(node.tool));
}

/**
 * @@@step-line — what else a lean page leaves out of a call. In the conversation view a call is its step line: the
 * kind of call and one detail (`toolStepDetail`) — the command, the path, the query, the address, the provider's
 * summary, or a line derived from the raw input when the call names none of these. The line shows no title, and
 * nothing reads the raw input or where the call worked. So the page carries the detail the line shows (deriving the
 * summary here, with the view's own function, when the view would have) and not the raw input or the locations, and
 * cuts the title to these characters. The line reads the same, to the letter; nothing is fetched later.
 * 5MB of the measured conversation.
 */
export const HELD_TITLE_CHARS = 80;

/**
 * Whether a call is only ever its step line to the conversation view. Not a sub-agent's own call (the roster lists
 * each with its title and whole detail), a call that left a background task (the task list names the task by its
 * title), nor the notice that such a task ended (its line is its title).
 */
function stepLineOnly(node: ToolNode): boolean {
  if (node.kind === 'background-command-done-tool-call') return false;
  if ('parentToolCallId' in node && node.parentToolCallId) return false;
  return !('backgroundTaskId' in node && node.backgroundTaskId);
}

/** Whether the view derives this call's step detail from its raw input: the last resort of `toolStepDetail`. */
function detailFromRawInput(node: ToolNode, source: Record<string, unknown>): boolean {
  if (node.kind === 'read-tool-call' || node.kind === 'search-tool-call' || node.kind === 'web-fetch-tool-call') return false;
  return source.inputSummary == null && (node.kind !== 'execute-tool-call' || source.command == null);
}

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind !== 'message' && item.kind !== 'thinking';
}

/** @returns 裁过的那一份，或者原对象（一个字都没超时）。 */
function trimToolNode(node: ToolNode, limit: number, lean = false): ToolNode {
  const source = node as unknown as Record<string, unknown>;
  let dropped = 0;
  let patch: Record<string, unknown> | null = null;
  const held = lean && outputUnshown(node);
  const line = held && stepLineOnly(node);
  const withheld: string[] = [];
  if (line) {
    if (typeof source.rawInput === 'string' && source.rawInput.length > 0) {
      withheld.push('rawInput');
      dropped += source.rawInput.length;
      const summary = detailFromRawInput(node, source) ? deriveToolInputSummary(source.rawInput) : undefined;
      patch = summary === undefined ? {} : { inputSummary: summary };
    }
    if (Array.isArray(source.locations) && source.locations.length > 0) { withheld.push('locations'); patch ??= {}; }
    if (typeof source.title === 'string' && source.title.length > HELD_TITLE_CHARS) {
      patch = { ...patch, title: source.title.slice(0, HELD_TITLE_CHARS) };
      dropped += source.title.length - HELD_TITLE_CHARS;
    }
  }

  for (const field of TRIMMED_FIELDS) {
    // A successful root send contains the conversation's message, just like a message item (a widget's data included).
    // Cutting its JSON makes the reply disappear on phones and remote desktops.
    if (field === 'rawInput' && node.kind === 'mcp-tool-call' && node.status === 'done'
      && !node.parentToolCallId && isGuguServer(node.server)
      && (node.tool === 'message_send' || node.tool === 'session_message' || node.tool === 'widget_send'
        || catalogCall(node.tool, node.rawInput)?.tool === 'widget_send')) continue;
    if (withheld.includes(field)) continue;
    const value = source[field];
    const fits = held && HELD_FIELDS.has(field) ? Math.min(limit, HELD_PREVIEW_CHARS) : limit;
    if (typeof value !== 'string' || value.length <= fits) continue;
    patch ??= {};
    patch[field] = value.slice(0, fits);
    dropped += value.length - fits;
  }

  const images = node.kind === 'tool-group' ? undefined : node.images;
  if (images) {
    patch ??= {};
    patch.imageRefs = imageRefsOf(images);
  }

  // Text and picture blocks are already projected into the trimmed `outputText` / `imageRefs` above;
  // only the blocks a view reads from the entity itself (patches, terminal references) travel.
  const blocks = node.kind === 'tool-group' ? undefined : node.contentBlocks;
  if (blocks?.some((block) => !TRANSPORTED_BLOCKS.has(block.type))) {
    patch ??= {};
    patch.contentBlocks = blocks.filter((block) => TRANSPORTED_BLOCKS.has(block.type));
  }

  // 工具组与嵌套调用都往下走：大输出常常挂在子调用上（一个 Bash 组里的某一条）。
  const children = node.children;
  const trimmedChildren = children ? trimToolNodes(children, limit, lean) : children;
  if (trimmedChildren !== children) {
    patch ??= {};
    patch.children = trimmedChildren;
  }

  if (!patch) return node;
  // 累加：这条调用**总共**少了多少字。它自己被裁过，`dropped` 就落在自己这一格上。
  const next: Record<string, unknown> = { ...node, ...patch, ...(dropped > 0 ? { trimmedChars: dropped } : {}) };
  for (const field of withheld) delete next[field];
  delete next.images;
  return next as unknown as ToolNode;
}

function trimToolNodes(nodes: readonly ToolNode[], limit: number, lean = false): ToolNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    const trimmed = trimToolNode(node, limit, lean);
    if (trimmed !== node) changed = true;
    return trimmed;
  });
  return changed ? next : (nodes as ToolNode[]);
}

export function trimItemsForTransport(
  items: readonly TranscriptItem[],
  limit = TRANSPORT_TEXT_LIMIT,
  lean = false,
): TranscriptItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (!isToolNode(item)) return item;
    const trimmed = trimToolNode(item, limit, lean);
    if (trimmed !== item) changed = true;
    return trimmed as TranscriptItem;
  });
  return changed ? next : (items as TranscriptItem[]);
}

/**
 * @@@text-sent-once — a message's canonical blocks, when they are nothing but its text. `text` is their projection
 * (message-fold), and a message without `content` already reads as one text block of its `text`, so a page that
 * carries both carries every message twice (a real 3055-turn conversation: 12.7MB of a 62.8MB history). Blocks that
 * hold anything else — a picture, a resource, a field beside `type` and `text` — travel as they are.
 * Pages only: a patch of the running turn keeps its objects (see the note on references above).
 */
function withoutEchoedContent(item: TranscriptItem): TranscriptItem {
  if (item.kind !== 'message' && item.kind !== 'thinking') return item;
  const content = item.content;
  if (!content) return item;
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string' || Object.keys(block).length !== 2) return item;
  }
  if (messageContentText(content) !== item.text) return item;
  const { content: _echo, ...rest } = item;
  return rest as TranscriptItem;
}

/**
 * A turn as a lean page carries it, or the turn itself when it holds nothing the view does without. Besides the
 * outputs: the turn's terminal captures (only the full command row reads them, by `terminalId`), and the provider's
 * own metadata on how the turn ended (`foreground._meta`; nothing on the reading side reads it). On the measured
 * conversation these two are 3.9MB and 1.0MB.
 */
function leanTurn(turn: TranscriptTurn, limit: number): TranscriptTurn {
  const items = trimItemsForTransport(turn.items, limit, true);
  const meta = turn.foreground !== undefined && '_meta' in turn.foreground;
  if (!turn.terminals && !meta) return items === turn.items ? turn : { ...turn, items };
  const { terminals: _captures, ...rest } = turn;
  if (!meta) return { ...rest, items };
  const { _meta: _provider, ...foreground } = turn.foreground as typeof turn.foreground & { _meta?: unknown };
  return { ...rest, items, foreground: foreground as NonNullable<TranscriptTurn['foreground']> };
}

/** What a page of turns sends: the field trim, each message's text once, and for a lean reader only the opening of output its view does not show. */
function projectTurnsForPage(turns: readonly TranscriptTurn[], limit: number, lean = false): TranscriptTurn[] {
  const held = lean ? turns.map(turn => leanTurn(turn, limit)) : null;
  const trimmed = !held ? trimTurnsForTransport(turns, limit) : held.some((turn, index) => turn !== turns[index]) ? held : turns;
  let changed = false;
  const next = trimmed.map((turn) => {
    let slimmed = false;
    const items = turn.items.map((item) => {
      const slim = withoutEchoedContent(item);
      if (slim !== item) slimmed = true;
      return slim;
    });
    if (!slimmed) return turn;
    changed = true;
    return { ...turn, items };
  });
  return changed ? next : (trimmed as TranscriptTurn[]);
}

export function trimTurnsForTransport(
  turns: readonly TranscriptTurn[],
  limit = TRANSPORT_TEXT_LIMIT,
): TranscriptTurn[] {
  let changed = false;
  const next = turns.map((turn) => {
    const items = trimItemsForTransport(turn.items, limit);
    if (items === turn.items) return turn;
    changed = true;
    return { ...turn, items };
  });
  return changed ? next : (turns as TranscriptTurn[]);
}

function trimPatches(patches: readonly TurnPatch[], limit: number): TurnPatch[] {
  let changed = false;
  const next = patches.map((patch) => {
    const items = trimItemsForTransport(patch.items, limit);
    if (items === patch.items) return patch;
    changed = true;
    return { ...patch, items };
  });
  return changed ? next : (patches as TurnPatch[]);
}

/**
 * 首屏（以及每一次「往前翻」）打包出去的**总量**上限，字节。
 *
 * 逐字段裁到 8K 只挡得住「一条工具输出几十万字」那一种胖法。导入进来的 CLI 会话是另一种：
 * 单条不长，但一轮里几十上百条 —— 实测一份 39MB 的 claude 记录，最近 20 轮里 204~373 条条目，
 * 逐字段裁完仍有 0.28~0.81MB，而**逐字段裁只省下 10%**（没有哪一条超过 8K）。
 * 这一包要走设备 RPC 的广播通道：单包上限 3000KB、每秒 100 条，且**整个库所有连接共用**。
 * 给一部手机的首屏发 0.8MB，既慢又在吃别人的额度。
 *
 * 所以这里再加一道总量闸：从**最旧**的那一轮开始丢，直到装得下。丢掉的那些不是没了 ——
 * `hasOlder` 会被抬成 true，手机往回翻时照原路 `getOlder` 取得到，与「快照本来就只给最近 N 轮」
 * 是同一套分页语义。❌ 不从最新的那头丢：首屏要的就是最近发生的事。
 * ❌ 也不允许丢到一轮不剩 —— 一轮再大也得发出去，否则屏幕上什么都没有，
 * 而「什么都没有」和「这条会话是空的」在界面上分不出来。
 */
export const TRANSPORT_PAYLOAD_BUDGET = 128 * 1024;

/**
 * 同一道总量闸，给**本机窗口读本机库**用的那一档：这一包只过进程间通道，不占设备 RPC 的额度，
 * 128K 在这里只会让一页剩下几轮（实测三条真实会话：128K 一页 4~7 轮，2M 一页 74~99 轮）。
 * 仍然要有上限：一页是一次同步解析加一次整表重排，❌ 放成无限。
 */
export const LOCAL_PAYLOAD_BUDGET = 2 * 1024 * 1024;

/**
 * 同一道总量闸，给**隔着设备连接往前翻**的那一页用（另一台电脑上的窗口、手机）。首屏仍是 128K：打开要快，
 * 人还没说要看更早的。往前翻是人（或「上方预留几屏」）开口要的：128K 一页只有几轮，翻一屏要来回好几趟；
 * 512K 一页几十轮，仍只是设备通道单包上限 3000K 的六分之一。
 */
export const REMOTE_OLDER_PAGE_BUDGET = 512 * 1024;

/** 一轮裁完以后在这一包里占多少字节 —— 读库的一侧据此在装满时停手，❌ 先读满 100 行再丢。 */
export function transportSizeOf(turn: TranscriptTurn, limit = TRANSPORT_TEXT_LIMIT, lean = false): number {
  return new TextEncoder().encode(JSON.stringify(projectTurnsForPage([turn], limit, lean)[0])).byteLength;
}

/**
 * 把一段轮压进总量预算。
 *
 * @returns 装得下的那一段（可能比传进来的短），以及是否真的丢过。
 */
function fitTurnsToBudget(
  turns: readonly TranscriptTurn[],
  budget: number,
): { turns: readonly TranscriptTurn[]; dropped: boolean } {
  if (turns.length <= 1) return { turns, dropped: false };
  // 每一轮各量一次（❌ 别按平均值估：轮与轮之间体量差几十倍是常态），
  // 再从**最新**那头往回累加，装不下就在那里断开。
  const encoder = new TextEncoder();
  const sizes = turns.map((turn) => encoder.encode(JSON.stringify(turn)).byteLength);
  let used = 2; // JSON array brackets.
  let start = turns.length - 1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const next = used + sizes[i] + (i < turns.length - 1 ? 1 : 0);
    // 最新的那一轮无条件保留，哪怕它自己就超预算。
    if (next > budget && i < turns.length - 1) break;
    used = next;
    start = i;
  }
  return start === 0 ? { turns, dropped: false } : { turns: turns.slice(start), dropped: true };
}

function trimTerminals(terminals: readonly TerminalState[] | undefined, limit: number): readonly TerminalState[] | undefined {
  if (!terminals?.some(terminal => terminal.output.length > limit)) return terminals;
  return terminals.map(terminal => terminal.output.length > limit
    ? { ...terminal, output: terminal.output.slice(0, limit), truncated: true } : terminal);
}

/** The phone and desktop cursor APIs use one field trim and one UTF-8 page budget. */
function trimTurnPageForTransport<T extends { turns: TranscriptTurn[]; hasOlder: boolean }>(
  page: T,
  limit: number,
  budget: number,
  lean = false,
): T {
  const trimmed = projectTurnsForPage(page.turns, limit, lean);
  const fitted = fitTurnsToBudget(trimmed, budget);
  if (trimmed === page.turns && !fitted.dropped) return page;
  return { ...page, turns: fitted.turns as TranscriptTurn[], hasOlder: page.hasOlder || fitted.dropped };
}

/** Adapt the same page budget to desktop's exclusive numeric cursor, keeping stored origins aligned. */
export function trimCursorPageForTransport<T extends {
  turns: TranscriptTurn[];
  nextCursor: number | null;
  originTurnIds?: readonly string[];
}>(
  page: T,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = TRANSPORT_PAYLOAD_BUDGET,
  lean = false,
): T {
  const trimmed = trimTurnPageForTransport(
    { turns: page.turns, hasOlder: page.nextCursor !== null }, limit, budget, lean,
  );
  if (trimmed.turns === page.turns) return page;
  const skipped = page.turns.length - trimmed.turns.length;
  return {
    ...page,
    turns: trimmed.turns,
    nextCursor: trimmed.hasOlder ? (trimmed.turns[0]?.seq ?? null) : null,
    ...(page.originTurnIds ? { originTurnIds: page.originTurnIds.slice(skipped) } : {}),
  };
}

export function trimSnapshotForTransport(
  snapshot: TimelineSnapshot,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = TRANSPORT_PAYLOAD_BUDGET,
): TimelineSnapshot {
  const terminals = trimTerminals(snapshot.terminals, limit);
  const page = trimTurnPageForTransport(snapshot, limit, budget);
  return terminals === snapshot.terminals ? page : { ...page, ...(terminals !== undefined ? { terminals } : {}) };
}

export function trimBatchForTransport(
  batch: TimelineBatch,
  limit = TRANSPORT_TEXT_LIMIT,
): TimelineBatch {
  const turns = trimPatches(batch.turns, limit);
  const terminals = trimTerminals(batch.terminals, limit);
  return turns === batch.turns && terminals === batch.terminals ? batch : { ...batch, turns, ...(terminals !== undefined ? { terminals } : {}) };
}

export function trimOlderForTransport(
  older: TimelineOlderResult,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = REMOTE_OLDER_PAGE_BUDGET,
): TimelineOlderResult {
  return trimTurnPageForTransport(older, limit, budget);
}

export function trimAfterResultForTransport(
  result: TimelineAfterResult,
  limit = TRANSPORT_TEXT_LIMIT,
): TimelineAfterResult {
  if (result.ok) {
    const batch = trimBatchForTransport(result.batch, limit);
    return batch === result.batch ? result : { ...result, batch };
  }
  const snapshot = trimSnapshotForTransport(result.snapshot, limit);
  return snapshot === result.snapshot ? result : { ...result, snapshot };
}
