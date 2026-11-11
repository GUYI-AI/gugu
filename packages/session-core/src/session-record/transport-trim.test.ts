import { textFilePatch } from '../lib/text-diff';
import { describe, expect, it } from 'vitest';

import type { ToolNode, TranscriptItem, TranscriptTurn } from '../acp/client';
import type { TimelineSnapshot, TurnPatch } from './contract';
import { deriveToolInputSummary } from './tool-input-summary';
import { turnHeld } from './held-turn';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import {
  HELD_BODY_CHARS,
  HELD_PREVIEW_CHARS,
  HELD_TITLE_CHARS,
  REMOTE_OLDER_PAGE_BUDGET,
  TRANSPORT_PAYLOAD_BUDGET,
  TRANSPORT_TEXT_LIMIT,
  trimAfterResultForTransport,
  trimBatchForTransport,
  trimCursorPageForTransport,
  trimOlderForTransport,
  trimSnapshotForTransport,
  trimTurnsForTransport,
  transportSizeOf
} from './transport-trim';

const LIMIT = 16;

function execTool(id: string, fields: Partial<Record<string, unknown>> = {}): ToolNode {
  return {
    kind: 'execute-tool-call',
    id,
    seq: 1,
    toolCallId: id,
    title: 'cat big.txt',
    status: 'done',
    ...fields
  } as ToolNode;
}

function turn(id: string, items: TranscriptItem[]): TranscriptTurn {
  return { id, role: 'assistant', startedAt: 1, items, outcome: null } as unknown as TranscriptTurn;
}

describe('发给手机那一份的裁剪', () => {
  it('keeps long root Gugu send messages parseable while trimming other tool payloads', () => {
    const text = 'Long reply '.repeat(1_000);
    const rawInput = JSON.stringify({ chat_id: 'dm', text });
    const send = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send',
      title: 'message_send', server: 'gugu', tool: 'message_send', status: 'done', rawInput,
      outputText: 'x'.repeat(LIMIT + 10) } as ToolNode;
    const calls = [send, { ...send, tool: 'session_message', server: 'plugin_gugu-dev_gugu' },
      { ...send, server: 'other' }, { ...send, parentToolCallId: 'parent' },
      { ...send, status: 'running' }, { ...send, tool: 'message_history' }] as ToolNode[];
    const [trimmed] = trimTurnsForTransport([turn('t1', calls)], LIMIT);
    const items = trimmed.items as Array<ToolNode & { rawInput: string; outputText: string }>;
    expect(JSON.parse(items[0].rawInput).text).toBe(text);
    expect(JSON.parse(items[1].rawInput).text).toBe(text);
    expect(items.every(item => item.outputText.length === LIMIT)).toBe(true);
    expect(items.slice(2).every(item => item.rawInput.length === LIMIT)).toBe(true);
  });

  it('超过上限的工具输出被裁到上限，并如实报出少了多少字', () => {
    const output = 'x'.repeat(LIMIT + 40);
    const [trimmed] = trimTurnsForTransport([turn('t1', [execTool('a', { outputText: output })])], LIMIT);
    const tool = trimmed.items[0] as ToolNode & { outputText: string; trimmedChars: number };

    expect(tool.outputText).toHaveLength(LIMIT);
    expect(tool.outputText).toBe(output.slice(0, LIMIT));
    // 留痕：看不出来的截断等于给了一个错的读数。
    expect(tool.trimmedChars).toBe(40);
  });

  it('阴控：没超上限的那一份原样返回**同一个引用**（❌ 不许平白重建一棵树）', () => {
    const turns = [turn('t1', [execTool('a', { outputText: 'x'.repeat(LIMIT) })])];
    expect(trimTurnsForTransport(turns, LIMIT)).toBe(turns);
    // 判据能判假的对照就在上一条：同样的输入多一个字符就会被裁。
    const longer = [turn('t1', [execTool('a', { outputText: 'x'.repeat(LIMIT + 1) })])];
    expect(trimTurnsForTransport(longer, LIMIT)).not.toBe(longer);
  });

  it('trims raw tool fields but preserves canonical patch bytes and structure', () => {
    const big = 'y'.repeat(LIMIT + 5);
    const [trimmed] = trimTurnsForTransport(
      [
        turn('t1', [
          execTool('a', { rawInput: big, rawOutput: big, outputText: big }),
          { ...execTool('b'), kind: 'patch-tool-call', contentBlocks: [textFilePatch('/f', 'before', big)] } as ToolNode
        ])
      ],
      LIMIT
    );
    const exec = trimmed.items[0] as Record<string, unknown>;
    const modify = trimmed.items[1] as Record<string, unknown>;
    expect([exec.rawInput, exec.rawOutput, exec.outputText]).toEqual([
      big.slice(0, LIMIT),
      big.slice(0, LIMIT),
      big.slice(0, LIMIT)
    ]);
    expect(exec.trimmedChars).toBe(15); // 三格各少 5
    expect(modify.contentBlocks).toEqual([textFilePatch('/f', 'before', big)]);
    expect(modify.trimmedChars).toBeUndefined();
  });

  it('carries only the entity blocks a view reads (patches, terminals); text and pictures travel as their trimmed projections', () => {
    const big = 'y'.repeat(LIMIT + 5);
    const patch = textFilePatch('/f', 'before', 'after');
    const blocks = [
      { type: 'content', content: { type: 'text', text: big } },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'x'.repeat(1_000) } },
      patch,
      { type: 'terminal', terminalId: 'term-1' },
    ];
    const tool = execTool('a', { contentBlocks: blocks, outputText: big, images: [{ mimeType: 'image/png', data: 'x'.repeat(1_000) }] });
    const [trimmed] = trimTurnsForTransport([turn('t1', [tool])], LIMIT);
    const item = trimmed.items[0] as Record<string, unknown>;
    expect(item.contentBlocks).toEqual([patch, { type: 'terminal', terminalId: 'term-1' }]);
    expect(item.outputText).toBe(big.slice(0, LIMIT));
    expect(item.imageRefs).toEqual([{ mimeType: 'image/png', chars: 1_000 }]);
    expect(JSON.stringify(item)).not.toContain('x'.repeat(1_000));
    // The original stays whole for on-demand reads.
    expect((tool as unknown as { contentBlocks: unknown[] }).contentBlocks).toHaveLength(4);
  });

  it('嵌在工具组里的子调用照裁 —— 大输出常常挂在某一条子调用上', () => {
    const big = 'z'.repeat(LIMIT + 3);
    const group = {
      kind: 'tool-group',
      id: 'g',
      seq: 1,
      label: '一组命令',
      groupKind: 'execute',
      status: 'done',
      children: [execTool('child', { outputText: big })]
    } as unknown as ToolNode;
    const [trimmed] = trimTurnsForTransport([turn('t1', [group])], LIMIT);
    const child = (trimmed.items[0] as unknown as { children: Record<string, unknown>[] }).children[0];
    expect(child.outputText).toHaveLength(LIMIT);
    expect(child.trimmedChars).toBe(3);
  });

  it('❌ 不碰人写的消息：只有工具带回来的大块内容才裁', () => {
    const long = 'w'.repeat(LIMIT + 100);
    const message = { kind: 'message', id: 'm', seq: 1, role: 'user', text: long } as unknown as TranscriptItem;
    const turns = [turn('t1', [message])];
    expect(trimTurnsForTransport(turns, LIMIT)).toBe(turns);
  });

  it('快照与增量两条路都裁（首屏那条只是推送那条的一个特例）', () => {
    const big = 'q'.repeat(LIMIT + 7);
    const snapshot = {
      turns: [turn('t1', [execTool('a', { outputText: big })])],
      cursor: { epoch: 'e', seq: 3 },
      hasOlder: false,
      settlements: {}
    } as unknown as TimelineSnapshot;

    const trimmedSnapshot = trimSnapshotForTransport(snapshot, LIMIT);
    expect((trimmedSnapshot.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);

    const patch = {
      id: 't1',
      role: 'assistant',
      startedAt: 1,
      outcome: null,
      itemIds: ['a'],
      items: [execTool('a', { outputText: big })]
    } as unknown as TurnPatch;
    const after = trimAfterResultForTransport(
      { ok: true, batch: { from: 0, cursor: { epoch: 'e', seq: 4 }, turns: [patch], removedTurnIds: [], settlements: [] } },
      LIMIT
    );
    if (!after.ok) throw new Error('unreachable');
    expect((after.batch.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);
    // 世代翻篇那一支带的是整份快照，同样要裁。
    const reset = trimAfterResultForTransport({ ok: false, reset: 'epoch_changed', snapshot }, LIMIT);
    if (reset.ok) throw new Error('unreachable');
    expect((reset.snapshot.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);
  });

  it('出厂上限是 8K —— 这是产品口径，改它要连着「桌面看完整」那句话一起改', () => {
    expect(TRANSPORT_TEXT_LIMIT).toBe(8_192);
  });
});

/**
 * 总量预算。逐字段裁只挡得住「一条输出几十万字」；导入进来的 CLI 会话是「单条不长、一轮里几十上百条」，
 * 那种胖法逐字段一个字都裁不掉（实测一份 39MB 的真记录裁完仍有 0.28~0.81MB，只省了 10%）。
 */
describe('首屏总量预算', () => {
  const snapshotOf = (turns: TranscriptTurn[], hasOlder = false): TimelineSnapshot =>
    ({ cursor: { epoch: 'e1', seq: 1 }, turns, settlements: [], hasOlder }) as unknown as TimelineSnapshot;

  /** 一轮 ≈ `size` 字节，且每条都在 8K 以下 —— 逐字段裁剪对它无能为力。 */
  const fatTurn = (id: string, items: number): TranscriptTurn =>
    turn(
      id,
      Array.from({ length: items }, (_, i) => execTool(`${id}-${i}`, { outputText: 'x'.repeat(1_000) }))
    );

  it('超预算 → 从最旧的那头丢，并把 hasOlder 抬起来', () => {
    const turns = Array.from({ length: 20 }, (_, i) => fatTurn(`t${i}`, 40));
    const before = JSON.stringify(turns).length;
    // 阳性前提：这一份确实逐字段裁不动（没有哪一条超过 8K），所以下面测的是总量闸本身。
    expect(JSON.stringify(trimTurnsForTransport(turns)).length).toBe(before);
    expect(before).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);

    const fitted = trimSnapshotForTransport(snapshotOf(turns));
    expect(JSON.stringify(fitted.turns).length).toBeLessThanOrEqual(TRANSPORT_PAYLOAD_BUDGET);
    expect(fitted.turns.length).toBeLessThan(turns.length);
    expect(fitted.hasOlder).toBe(true);
    // 留下的必须是**最新**的那一段,❌ 不是最旧的。
    expect(fitted.turns.at(-1)!.id).toBe('t19');
  });

  it('装得下就一个字不动 —— 同一个引用原样返回', () => {
    const snapshot = snapshotOf([fatTurn('t0', 2)]);
    expect(trimSnapshotForTransport(snapshot)).toBe(snapshot);
  });

  it('最新那一轮自己就超预算 → 照样发出去,❌ 不许发成空的', () => {
    const huge = fatTurn('big', 400);
    expect(JSON.stringify([huge]).length).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    const fitted = trimSnapshotForTransport(snapshotOf([fatTurn('old', 40), huge]));
    expect(fitted.turns.map((t) => t.id)).toEqual(['big']);
    expect(fitted.hasOlder).toBe(true);
  });

  it('往前翻的那一页同样受预算约束,且丢过就说还有更早的', () => {
    const turns = Array.from({ length: 60 }, (_, i) => fatTurn(`o${i}`, 40));
    const older = trimOlderForTransport({ epoch: 'e1', turns, hasOlder: false });
    expect(JSON.stringify(older.turns).length).toBeLessThanOrEqual(REMOTE_OLDER_PAGE_BUDGET);
    expect(older.hasOlder).toBe(true);
    // 接口语义:返回的这一段必须紧挨着手机手里那份的左边,所以丢的是更旧的那头。
    expect(older.turns.at(-1)!.id).toBe('o59');
  });

  it('往前翻的那一页比首屏大:首屏要开得快,往前翻是人开口要的', () => {
    const turns = Array.from({ length: 60 }, (_, i) => fatTurn(`o${i}`, 40));
    const first = trimSnapshotForTransport(snapshotOf(turns));
    const older = trimOlderForTransport({ epoch: 'e1', turns, hasOlder: false });
    expect(JSON.stringify(first.turns).length).toBeLessThanOrEqual(TRANSPORT_PAYLOAD_BUDGET);
    expect(JSON.stringify(older.turns).length).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    expect(older.turns.length).toBeGreaterThan(3 * first.turns.length);
  });
});

/**
 * owner 10-15「手机上看的话每张图传过去岂不是很 costly」:图不随记录下发。发给手机的那一份里每张图只留
 * `{ mimeType, chars }`(`imageRefs`),手机滚到它、那一轮展开了再按 (会话, 条目, 第几张) 去取。
 */
describe('工具交回来的图只带类型和字数', () => {
  const snapshotOf = (turns: TranscriptTurn[]): TimelineSnapshot =>
    ({ cursor: { epoch: 'e1', seq: 1 }, turns, settlements: [], hasOlder: false }) as unknown as TimelineSnapshot;
  const picture = (chars: number, mark: string) => ({ mimeType: 'image/jpeg', data: mark.repeat(chars) });
  /** app_check 交回的那四张(真记录:4 张共 119,120 字)。 */
  const fourShots = () => [31, 29, 30, 29].map((k, i) => picture(k * 1024, 'abcd'[i]!));
  const toolOf = (t: TranscriptTurn) => t.items[0] as Record<string, unknown>;

  it('快照里每张图换成 { mimeType, chars },图数据一个字都不带;图没丢,❌ 算进 trimmedChars', () => {
    const fitted = trimSnapshotForTransport(snapshotOf([turn('t1', [execTool('a', { outputText: 'ok', images: fourShots() })])]));
    const tool = toolOf(fitted.turns[0]!);
    expect(tool).not.toHaveProperty('images');
    expect(tool.imageRefs).toEqual([31, 29, 30, 29].map((k) => ({ mimeType: 'image/jpeg', chars: k * 1024 })));
    expect(tool).not.toHaveProperty('trimmedChars');
    expect(JSON.stringify(fitted)).not.toContain('aaaaaaaa');
  });

  it('首屏轮数不再被图挤掉:四轮各带四张,四轮都在、hasOlder 不抬(以前带图的一轮自己就占满一页)', () => {
    const turns = ['t1', 't2', 't3', 't4'].map((id) => turn(id, [execTool(`${id}-check`, { images: fourShots() })]));
    // 阳性前提:图要是跟着走,两轮就装不下一页。
    expect(JSON.stringify(turns.slice(-2)).length).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    const fitted = trimSnapshotForTransport(snapshotOf(turns));
    expect(fitted.turns.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(fitted.hasOlder).toBe(false);
    expect(fitted.turns.map((t) => (toolOf(t).imageRefs as unknown[]).length)).toEqual([4, 4, 4, 4]);
  });

  it('订阅推来的增量、往前翻的那一页、工具组里的子调用,都一样只带类型和字数', () => {
    const patch = { ...turn('t1', [execTool('a', { images: fourShots() })]), itemIds: ['a'] } as unknown as TurnPatch;
    const batch = trimBatchForTransport({ from: 0, cursor: { epoch: 'e1', seq: 2 }, turns: [patch], removedTurnIds: [], settlements: [] });
    expect(batch.turns[0]!.items[0]).not.toHaveProperty('images');
    expect((batch.turns[0]!.items[0] as Record<string, unknown>).imageRefs).toHaveLength(4);

    const older = trimOlderForTransport({ epoch: 'e1', turns: [turn('o1', [execTool('b', { images: fourShots() })])], hasOlder: false });
    expect(toolOf(older.turns[0]!).imageRefs).toHaveLength(4);

    const group = { ...execTool('g'), kind: 'tool-group', children: [execTool('child', { images: fourShots() })] } as unknown as ToolNode;
    const [trimmed] = trimTurnsForTransport([turn('t1', [group])]);
    const child = (toolOf(trimmed!).children as Record<string, unknown>[])[0]!;
    expect(child).not.toHaveProperty('images');
    expect(child.imageRefs).toHaveLength(4);
  });

  it('桌面读的那一份不动:换的是一份新的,原条目上的图一张不少', () => {
    const images = fourShots();
    const tool = execTool('a', { images });
    trimTurnsForTransport([turn('t1', [tool])]);
    expect((tool as unknown as { images: unknown[] }).images).toBe(images);
  });
});

describe('desktop cursor pages share the phone transport budget', () => {
  const fat = (seq: number): TranscriptTurn => ({
    ...turn(`t${seq}`, Array.from({ length: 40 }, (_, i) =>
      execTool(`t${seq}-tool-${i}`, { outputText: 'x'.repeat(1_000) }))),
    seq,
  });

  it('reaches every omitted older turn exactly once and keeps stored origins aligned', () => {
    const source = Array.from({ length: 20 }, (_, seq) => fat(seq));
    const received: TranscriptTurn[] = [];
    let before: number | undefined;
    do {
      const turns = source.filter(t => before === undefined || t.seq < before);
      const original = {
        turns, originTurnIds: turns.map(t => `runtime-${t.seq}`), nextCursor: null as number | null,
        cursor: { epoch: 'same-runtime', seq: 20 }, count: 20,
      };
      const page = trimCursorPageForTransport(original);
      expect(new TextEncoder().encode(JSON.stringify(page.turns)).byteLength).toBeLessThanOrEqual(TRANSPORT_PAYLOAD_BUDGET);
      expect(page.turns.length).toBeGreaterThan(0);
      expect(page.originTurnIds).toEqual(page.turns.map(t => `runtime-${t.seq}`));
      expect(page.cursor).toBe(original.cursor);
      expect(page.count).toBe(20);
      received.unshift(...page.turns);
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
    expect(received.map(t => t.id)).toEqual(source.map(t => t.id));
    expect(new Set(received.map(t => t.id)).size).toBe(source.length);
    expect(source[0].items).toHaveLength(40);
  });

  it('budgets UTF-8 bytes while leaving user text intact', () => {
    const text = '界'.repeat(20_000);
    const turns = Array.from({ length: 5 }, (_, seq) => ({
      ...turn(`u${seq}`, [{ kind: 'message', id: `m${seq}`, text } as TranscriptItem]), seq,
    }));
    expect(JSON.stringify(turns).length).toBeLessThan(TRANSPORT_PAYLOAD_BUDGET);
    expect(new TextEncoder().encode(JSON.stringify(turns)).byteLength).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    const page = trimCursorPageForTransport({ turns, nextCursor: null });
    expect(page.turns.map(t => t.seq)).toEqual([3, 4]);
    expect(page.nextCursor).toBe(3);
    expect((page.turns[0].items[0] as { text: string }).text).toBe(text);
  });
});


// `text` is the projection of `content` (message-fold), and a message without `content` reads as one text block of
// its `text`: a page that carries both carries every message twice.
describe('a page sends each message\'s text once', () => {
  const message = (fields: Record<string, unknown>): TranscriptItem =>
    ({ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'Hello, world', ...fields }) as TranscriptItem;
  const paged = (item: TranscriptItem) =>
    trimCursorPageForTransport({ turns: [turn('t', [item])], nextCursor: null }).turns[0]!.items[0] as Record<string, unknown>;

  it('drops canonical blocks that are nothing but the text, in however many pieces', () => {
    expect(paged(message({ content: [{ type: 'text', text: 'Hello, world' }] }))).not.toHaveProperty('content');
    expect(paged(message({ content: [{ type: 'text', text: 'Hello, ' }, { type: 'text', text: 'world' }] }))).not.toHaveProperty('content');
    expect(paged(message({ text: '', content: [] }))).not.toHaveProperty('content');
    const thinking = { kind: 'thinking', id: 'th', seq: 0, segmentId: 's', text: 'reason', status: 'done', startedAt: 1,
      content: [{ type: 'text', text: 'reason' }] } as TranscriptItem;
    expect(paged(thinking)).not.toHaveProperty('content');
    expect(paged(thinking).text).toBe('reason');
  });

  it('keeps blocks that hold anything the text does not', () => {
    const picture = [{ type: 'text', text: 'Hello, world' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }];
    expect(paged(message({ content: picture })).content).toEqual(picture);
    const annotated = [{ type: 'text', text: 'Hello, world', annotations: { audience: ['user'] } }];
    expect(paged(message({ content: annotated })).content).toEqual(annotated);
    const other = [{ type: 'text', text: 'Hello' }];
    expect(paged(message({ content: other })).content).toEqual(other);
  });

  it('leaves a message without blocks, and a patch of the running turn, as they are', () => {
    const plain = message({});
    const page = { turns: [turn('t', [plain])], nextCursor: null };
    expect(trimCursorPageForTransport(page)).toBe(page);
    const streaming = message({ content: [{ type: 'text', text: 'Hello, world' }] });
    const batch = { epoch: 'e1', fromSeq: 0, toSeq: 1, turns: [{ turnId: 't', items: [streaming] } as unknown as TurnPatch] };
    expect(trimBatchForTransport(batch as never)).toBe(batch);
  });

  it('counts the page by what is sent', () => {
    const text = 'x'.repeat(60_000);
    const turns = Array.from({ length: 4 }, (_, i) => ({ ...turn(`t${i}`, [message({ id: `m${i}`, text, content: [{ type: 'text', text }] })]), seq: i }));
    // Sent twice, two of these fill 128K; sent once, all four fit under 256K.
    const page = trimCursorPageForTransport({ turns, nextCursor: null }, TRANSPORT_TEXT_LIMIT, 256 * 1024);
    expect(page.turns).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
  });
});

// The conversation view draws a call as one line and shows its output nowhere; a reader with that view asks for lean
// pages. Held here: what such a page leaves out, and what it never does (the view reads or shows it).
describe('a lean page leaves out output the conversation view does not show', () => {
  const long = 'o'.repeat(HELD_PREVIEW_CHARS * 4);
  const lean = (items: TranscriptItem[], extra: Record<string, unknown> = {}) =>
    trimCursorPageForTransport({ turns: [{ ...turn('t', items), ...extra }], nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true).turns[0]!;
  const gugu = (tool: string, fields: Record<string, unknown> = {}) =>
    ({ kind: 'mcp-tool-call', id: tool, seq: 1, toolCallId: tool, server: 'gugu', tool, status: 'done', rawInput: '{}', ...fields }) as unknown as ToolNode;

  it('sends the opening of a finished call\'s output and says how much is missing', () => {
    const call = lean([execTool('e', { outputText: long, rawOutput: long, command: long })]).items[0] as unknown as Record<string, unknown>;
    expect(call.outputText).toBe(long.slice(0, HELD_PREVIEW_CHARS));
    expect(call.rawOutput).toBe(long.slice(0, HELD_PREVIEW_CHARS));
    // What the step line shows (the command) is whole.
    expect(call.command).toBe(long);
    expect(call.trimmedChars).toBe(2 * (long.length - HELD_PREVIEW_CHARS));
  });

  it('does the same for a call inside a group', () => {
    const group = { kind: 'tool-group', id: 'g', seq: 1, status: 'done', children: [execTool('c', { outputText: long })] } as unknown as ToolNode;
    expect(((lean([group]).items[0] as ToolNode).children![0] as unknown as Record<string, unknown>).outputText).toHaveLength(HELD_PREVIEW_CHARS);
  });

  it('carries no terminal capture and no provider metadata of how the turn ended; what the turn says of itself stays', () => {
    const sent = lean([execTool('e', { terminalId: 'term', outputText: 'ok' })], {
      terminals: [{ terminalId: 'term', output: 'ok', truncated: false }],
      foreground: { source: 'agent', state: 'idle', stopReason: 'end_turn', _meta: { vendor: long } }, outcome: { kind: 'done' },
    }) as unknown as Record<string, unknown>;
    expect(sent).not.toHaveProperty('terminals');
    expect(sent.foreground).toEqual({ source: 'agent', state: 'idle', stopReason: 'end_turn' });
    expect(sent.outcome).toEqual({ kind: 'done' });
    // The call still names its terminal: a view that reads captures would ask for the whole turn.
    expect((sent.items as Array<Record<string, unknown>>)[0]!.terminalId).toBe('term');
  });

  it('sends whole what the view reads or shows: a failure\'s reason, a patch, a sub-agent, a question\'s answer, a send\'s receipt, what a tab opened', () => {
    const receipt = JSON.stringify({ message_id: 'msg:1', note: long });
    const kept: ToolNode[] = [
      execTool('failed', { status: 'failed', outputText: long }),
      execTool('running', { status: 'running', outputText: long }),
      { ...execTool('patch', { outputText: long }), kind: 'patch-tool-call' } as ToolNode,
      { ...execTool('agent', { outputText: long }), kind: 'spawn-subagent-tool-call' } as ToolNode,
      execTool('question', { kind: 'unknown-tool-call', toolName: 'AskUserQuestion', outputText: long }),
      gugu('message_send', { rawOutput: receipt }),
      gugu('session_open_in_tab', { outputText: receipt }),
      { ...gugu('mcp__plugin_x_gugu__message_send_file', { rawOutput: receipt }), server: 'plugin_x_gugu' } as ToolNode,
    ];
    const page = { turns: [turn('t', kept)], nextCursor: null };
    // Nothing was left out, so nothing is rebuilt.
    expect(trimCursorPageForTransport(page, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true)).toBe(page);
    // A Gugu call whose answer the view does not read is like any other.
    expect((lean([gugu('message_history', { outputText: long })]).items[0] as unknown as Record<string, unknown>).outputText).toHaveLength(HELD_PREVIEW_CHARS);
  });

  it('leaves a reader that did not ask as before', () => {
    const page = { turns: [turn('t', [execTool('e', { outputText: long })])], nextCursor: null, terminals: undefined };
    expect(trimCursorPageForTransport(page)).toBe(page);
  });

  it('counts a lean page by what it sends, so it holds more turns', () => {
    const heavy = (index: number) => ({ ...turn(`t${index}`, [execTool(`e${index}`, { outputText: 'o'.repeat(8_000) })]), seq: index });
    expect(transportSizeOf(heavy(0), TRANSPORT_TEXT_LIMIT, true)).toBeLessThan(transportSizeOf(heavy(0)) / 10);
    const turns = Array.from({ length: 40 }, (_, index) => heavy(index));
    expect(trimCursorPageForTransport({ turns, nextCursor: null }).turns.length).toBeLessThan(20);
    expect(trimCursorPageForTransport({ turns, nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true).turns).toHaveLength(40);
  });
});

// In the conversation view a call is its step line: the kind of call and one detail. A lean page carries that detail
// and not the raw input it may have come from. `detail` below is `toolStepDetail`, the view's own choice of it.
describe('a lean page carries what a call\'s step line shows, not its raw input', () => {
  const input = JSON.stringify({ url: 'https://example.com/a', depth: 2, body: 'b'.repeat(4_000) });
  const lean = (items: TranscriptItem[]) =>
    trimCursorPageForTransport({ turns: [turn('t', items)], nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true).turns[0]!;
  const detail = (item: Record<string, unknown>) => {
    switch (item.kind) {
      case 'execute-tool-call': return item.command ?? item.inputSummary ?? deriveToolInputSummary(item.rawInput as string | undefined);
      case 'read-tool-call': return item.path ?? item.resource;
      case 'search-tool-call': return item.query;
      case 'web-fetch-tool-call': return item.url;
      default: return item.inputSummary ?? deriveToolInputSummary(item.rawInput as string | undefined);
    }
  };
  const node = (fields: Record<string, unknown>) =>
    ({ id: 'n', seq: 1, toolCallId: 'n', title: 'run', status: 'done', rawInput: input, locations: [{ path: '/a' }], ...fields }) as unknown as ToolNode;
  const calls: ToolNode[] = [
    node({ kind: 'execute-tool-call', command: 'c'.repeat(2_000) }),
    node({ kind: 'execute-tool-call', inputSummary: 'make test' }),
    node({ kind: 'execute-tool-call' }),
    node({ kind: 'execute-tool-call', command: '' }),
    node({ kind: 'read-tool-call', path: '/a/b.ts' }),
    node({ kind: 'read-tool-call' }),
    node({ kind: 'search-tool-call', query: 'needle' }),
    node({ kind: 'web-fetch-tool-call', url: 'https://example.com' }),
    node({ kind: 'mcp-tool-call', server: 'github', tool: 'search' }),
    node({ kind: 'mcp-tool-call', server: 'github', tool: 'search', inputSummary: '' }),
    node({ kind: 'mcp-tool-call', server: 'gugu', tool: 'message_history' }),
    node({ kind: 'unknown-tool-call', toolName: 'Skill', rawInput: 'not json  at all' }),
    node({ kind: 'unknown-tool-call', toolName: 'Skill', rawInput: '{}' }),
  ];

  it('leaves every line as the view would have drawn it from the whole call', () => {
    const sent = lean(calls).items as unknown as Array<Record<string, unknown>>;
    expect(sent.map(detail)).toEqual((calls as unknown as Array<Record<string, unknown>>).map(detail));
    for (const call of sent) {
      expect(call).not.toHaveProperty('rawInput');
      expect(call).not.toHaveProperty('locations');
    }
    // Derived only where the view would have derived it; a call that names its own detail is not given another.
    expect(sent.map(call => call.inputSummary)).toEqual([
      undefined, 'make test', deriveToolInputSummary(input), undefined, undefined, undefined, undefined, undefined,
      deriveToolInputSummary(input), '', deriveToolInputSummary(input), 'not json at all', undefined,
    ]);
    expect(sent[2]!.trimmedChars).toBe(input.length);
  });

  it('cuts a long title, which the line does not show, and leaves a call with nothing to leave out as it is', () => {
    const titled = lean([execTool('e', { title: 't'.repeat(HELD_TITLE_CHARS * 2), command: 'ls' })]).items[0] as unknown as Record<string, unknown>;
    expect(titled).toMatchObject({ title: 't'.repeat(HELD_TITLE_CHARS), command: 'ls', trimmedChars: HELD_TITLE_CHARS });
    const page = { turns: [turn('t', [execTool('e', { command: 'ls' })])], nextCursor: null };
    expect(trimCursorPageForTransport(page, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true)).toBe(page);
  });

  it('sends whole the calls the view reads more of than a line', () => {
    const more = { title: 't'.repeat(HELD_TITLE_CHARS * 2) };
    const kept: ToolNode[] = [
      node({ kind: 'execute-tool-call', status: 'failed', ...more }),
      node({ kind: 'execute-tool-call', status: 'in_progress', ...more }),
      node({ kind: 'patch-tool-call', ...more }),
      node({ kind: 'spawn-subagent-tool-call', ...more }),
      node({ kind: 'unknown-tool-call', toolName: 'AskUserQuestion', ...more }),
      node({ kind: 'mcp-tool-call', server: 'gugu', tool: 'message_send', ...more }),
      node({ kind: 'mcp-tool-call', server: 'gugu', tool: 'session_open_in_tab', ...more }),
      // A sub-agent's own call (the roster lists it with its title and whole detail), a call that left a background
      // task (the task list names it), and the notice that the task ended (its line is its title).
      node({ kind: 'execute-tool-call', parentToolCallId: 'agent-1', ...more }),
      node({ kind: 'execute-tool-call', backgroundTaskId: 'task-1', ...more }),
      node({ kind: 'background-command-done-tool-call', ...more }),
    ];
    const sent = lean(kept).items as unknown as Array<Record<string, unknown>>;
    expect(sent.map(call => [call.rawInput, call.title, call.locations])).toEqual(kept.map(() => [input, more.title, [{ path: '/a' }]]));
    expect(sent.every(call => call.inputSummary === undefined)).toBe(true);
  });

  it('leaves a reader that did not ask for lean pages the raw input', () => {
    const sent = trimCursorPageForTransport({ turns: [turn('t', calls)], nextCursor: null }).turns[0]!.items as unknown as Array<Record<string, unknown>>;
    expect(sent.map(call => call.rawInput)).toEqual((calls as unknown as Array<Record<string, unknown>>).map(call => call.rawInput));
    expect(sent.every(call => call.title === 'run' && Array.isArray(call.locations))).toBe(true);
  });
});

// A reader that reads a turn again when one of its folds is opened asks for 'folded'. A page then carries what the
// folded conversation shows, and what stands behind a fold as a marked stub (`held`).
describe('a folded page leaves out what stands behind a fold', () => {
  const AGENT = 'user:11111111-1111-4111-8111-111111111111', HUMAN = 'user:22222222-2222-4222-8222-222222222222';
  const folded = (turns: TranscriptTurn[]) => trimCursorPageForTransport({ turns, nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, 'folded').turns;
  const one = (items: TranscriptItem[]) => folded([turn('t', items)])[0]!;
  const delivery = (id: string, from: string, type: string | null, body = 'b'.repeat(600)) => ({ kind: 'message', id, seq: 0, role: 'user', text:
    `<gugu_delivery route="chat" chat="dm-1" chat_kind="dm" from="d3" from_id="${from}"${type ? ` from_type="${type}"` : ''} msg="msg:${id}">\n  <message_context><![CDATA[${'c'.repeat(300)}]]></message_context>\n<![CDATA[${body}]]>\n  <arrival>reply with message_send</arrival>\n</gugu_delivery>` }) as unknown as TranscriptItem;
  const step = (fields: Record<string, unknown> = {}) => execTool('e', { title: 'Run', command: 'make test', rawInput: '{"command":"make test"}', outputText: 'ok', completedAt: 5, terminalId: 'term', ...fields });

  it('carries a finished step as what orders, counts and times it, marked', () => {
    const sent = one([step()]);
    expect(sent.items[0]).toEqual({ kind: 'execute-tool-call', id: 'e', seq: 1, toolCallId: 'e', title: '', status: 'done', completedAt: 5, held: true });
    expect(turnHeld(sent)).toBe(true);
  });

  it('does the same for a step that failed, keeping how it ended', () => {
    expect(one([step({ status: 'error' })]).items[0]).toMatchObject({ status: 'error', held: true, title: '' });
    expect(one([step({ status: 'error' })]).items[0]).not.toHaveProperty('outputText');
  });

  it('keeps a step inside a group, and the group', () => {
    const group = { kind: 'tool-group', id: 'g', seq: 1, status: 'done', children: [step()] } as unknown as ToolNode;
    const sent = one([group]);
    expect((sent.items[0] as ToolNode).children).toEqual([{ kind: 'execute-tool-call', id: 'e', seq: 1, toolCallId: 'e', title: '', status: 'done', completedAt: 5, held: true }]);
    expect(turnHeld(sent)).toBe(true);
  });

  it('carries a thought without its text', () => {
    const thought = { kind: 'thinking', id: 'th', seq: 0, text: 'long thought', status: 'done' } as unknown as TranscriptItem;
    expect(one([thought]).items[0]).toEqual({ kind: 'thinking', id: 'th', seq: 0, text: '', status: 'done', held: true });
  });

  it('cuts a delivery from an agent to its opening and drops what stands beside it; one from a person stays whole', () => {
    const [agent, person] = one([delivery('a', AGENT, 'agent'), delivery('h', HUMAN, 'human')]).items as unknown as Array<{ text: string; held?: true }>;
    expect(agent!.held).toBe(true);
    const read = readDeliveryEnvelope(agent!.text)!.segments[0]!;
    expect(read.body).toBe('b'.repeat(HELD_BODY_CHARS));
    expect(read.facts).toMatchObject({ fromId: AGENT, fromType: 'agent', messageId: 'msg:a', chat: 'dm-1', messageContext: null });
    expect(person).toEqual(delivery('h', HUMAN, 'human'));
  });

  it('takes an envelope from before senders were typed for an agent only when another envelope of the page proves the sender one', () => {
    const proven = one([delivery('a', AGENT, 'agent'), delivery('old', AGENT, null)]).items as unknown as Array<{ held?: true }>;
    expect(proven.map(item => item.held)).toEqual([true, true]);
    expect((one([delivery('old', AGENT, null)]).items[0] as { held?: true }).held).toBeUndefined();
  });

  it('leaves a delivery with nothing to cut, and what a person typed, as they are', () => {
    const short = (delivery('s', AGENT, 'agent', 'ok') as unknown as { text: string }).text;
    const bare = { kind: 'message', id: 's', seq: 0, role: 'user', text: short.replace(/\n {2}<message_context>.*<\/message_context>/s, '').replace(/\n {2}<arrival>.*<\/arrival>/s, '') } as unknown as TranscriptItem;
    const typed = { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'x'.repeat(2_000) } as unknown as TranscriptItem;
    const said = { kind: 'message', id: 'r', seq: 2, role: 'assistant', text: 'y'.repeat(2_000) } as unknown as TranscriptItem;
    const page = { turns: [turn('t', [bare, typed, said])], nextCursor: null };
    expect(trimCursorPageForTransport(page, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, 'folded')).toBe(page);
    expect(turnHeld(page.turns[0]!)).toBe(false);
  });

  it('cuts what the agent sent to agents only, and leaves what it sent to a person', () => {
    const send = (id: string, to: string) => ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, server: 'gugu', tool: 'message_send', status: 'done', title: 'send',
      rawInput: JSON.stringify({ chat_id: 'dm-1', to_user_ids: [to], text: 'w'.repeat(900) }),
      outputText: 'sent (id=msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)' }) as unknown as ToolNode;
    const [, toAgent, toPerson] = one([delivery('a', AGENT, 'agent'), send('s1', AGENT), send('s2', HUMAN)]).items as unknown as Array<Record<string, unknown>>;
    expect(toAgent!.held).toBe(true);
    expect(JSON.parse(toAgent!.rawInput as string)).toEqual({ chat_id: 'dm-1', to_user_ids: [AGENT], text: 'w'.repeat(HELD_BODY_CHARS) });
    expect(toAgent!.outputText).toBe('sent (id=msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)');
    expect(toPerson).toEqual(send('s2', HUMAN));
    // Without an envelope that proves the recipient an agent, the send is whole.
    expect(one([send('s1', AGENT)]).items[0]).toEqual(send('s1', AGENT));
  });

  it('keeps what the roster reads of a sub-agent\'s own call, and stubs it under a sub-agent the page shows ended', () => {
    const child = step({ parentToolCallId: 'agent-1', title: 'Run tests' });
    const running = one([child]).items[0] as unknown as Record<string, unknown>;
    expect(running).toMatchObject({ title: 'Run tests', command: 'make test' });
    expect(running).not.toHaveProperty('rawInput');
    expect(running).not.toHaveProperty('outputText');
    expect(running).not.toHaveProperty('held');
    const spawn = { kind: 'spawn-subagent-tool-call', id: 'sp', seq: 0, toolCallId: 'agent-1', title: 'Explore', status: 'done', agentStatus: 'completed', name: 'Explore' } as unknown as ToolNode;
    const ended = one([spawn, child]);
    expect(ended.items[1]).toEqual({ kind: 'execute-tool-call', id: 'e', seq: 1, toolCallId: 'e', title: '', status: 'done', completedAt: 5, parentToolCallId: 'agent-1' });
    expect(ended.items[0]).toEqual(spawn);
    expect(turnHeld(ended)).toBe(false);
  });

  it('sends a finished patch without the raw input its diff blocks repeat', () => {
    const patch = { kind: 'patch-tool-call', id: 'p', seq: 1, toolCallId: 'p', title: 'Edit', status: 'done', rawInput: '{"file_path":"/a","old_string":"x","new_string":"y"}',
      contentBlocks: [{ type: 'diff', path: '/a', oldText: 'x', newText: 'y' }] } as unknown as ToolNode;
    const sent = one([patch]).items[0] as unknown as Record<string, unknown>;
    expect(sent).not.toHaveProperty('rawInput');
    expect(sent.contentBlocks).toEqual((patch as unknown as Record<string, unknown>).contentBlocks);
    expect(sent).not.toHaveProperty('held');
  });

  it('sends whole what the folded conversation shows: questions, sub-agent dispatch, opened tabs, background tasks', () => {
    const kept: ToolNode[] = [
      step({ kind: 'unknown-tool-call', toolName: 'AskUserQuestion' }),
      step({ kind: 'spawn-subagent-tool-call' }),
      { kind: 'mcp-tool-call', id: 'o', seq: 1, toolCallId: 'o', server: 'gugu', tool: 'session_open_in_tab', status: 'done', title: 'open', rawInput: '{"path":"/a.html"}', outputText: '{"path":"/a.html"}' } as unknown as ToolNode,
      step({ backgroundTaskId: 'task-1' }),
      step({ kind: 'background-command-done-tool-call' }),
      step({ status: 'running' }),
    ];
    const sent = one(kept);
    expect(turnHeld(sent)).toBe(false);
    expect(sent.items.map(item => (item as unknown as Record<string, unknown>).rawInput)).toEqual(kept.map(item => (item as unknown as Record<string, unknown>).rawInput));
  });

  it('leaves a lean page as it was: nothing is marked', () => {
    const lean = trimCursorPageForTransport({ turns: [turn('t', [delivery('a', AGENT, 'agent'), step(), { kind: 'thinking', id: 'th', seq: 0, text: 'thought' } as unknown as TranscriptItem])], nextCursor: null },
      TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, true).turns[0]!;
    expect(turnHeld(lean)).toBe(false);
    expect(lean.items[0]).toEqual(delivery('a', AGENT, 'agent'));
    expect(lean.items[1]).toMatchObject({ command: 'make test' });
    expect(lean.items[2]).toMatchObject({ text: 'thought' });
  });
});
