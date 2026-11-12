import { describe, expect, it } from 'vitest';
import { unit, type ItemSegmenter, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { flattenTier as flattenTierWithViewports } from './flatten';
// Assert chronological leaves independently of their bounded viewport wrapper.
const flattenTier = (...args: Parameters<typeof flattenTierWithViewports>) => flattenTierWithViewports(...args).flatMap(row => row.children ?? [row]);
import { conversationOutput } from './conversation-process';
import { conversationBackgroundOwner } from './conversation-background';
import { joinContinuedTurns, planConversationSegments, withContinuedActiveTurn } from './conversation-segments';
import { messageQuoteLink, messageQuoteText } from '@gugu/core/shared/ui/messageQuote';

const message = (id: string, role: 'user' | 'assistant', at?: number): ChatMessage => ({ kind: 'message', id, seq: 0, role, text: id, ...(at === undefined ? {} : { at }) });
const call = (id: string): ChatItem => ({ kind: 'execute-tool-call', id, toolCallId: id, seq: 0, title: id, status: 'done' });
const notice = (id: string, at: number): ChatItem => ({ kind: 'subagent-done-tool-call', id, toolCallId: id, seq: 0, title: id, status: 'done', name: id, agentId: id, launchToolCallId: id, outcome: 'completed', at });
const turn = (items: ChatItem[]): TranscriptTurn => ({ id: 't', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 9000, items: items as TranscriptTurn['items'] });
const segmenters = Object.fromEntries(['day-separator', 'message', 'turn-process', 'tool-run', 'execute-tool-call', 'subagent-done-tool-call', 'background-command-done-tool-call', 'mcp-tool-call', 'agent-send', 'compaction'].map(kind => [kind, {
  kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
} satisfies ItemSegmenter]));
const context = (active: boolean, toggles: string[] = []): SegmentCtx => ({ caches: {}, expanded: () => false, active,
  foldTurnProcess: true, agentConversation: true, translate: defaultChatTranslator, plan: () => null,
  pendingToolCallIds: () => new Set(), terminalSnapshot: () => null,
  isTurnProcessExpanded: (id: string) => toggles.includes(id),
} as unknown as SegmentCtx);

describe('replay conversation segment boundaries', () => {
  it('keeps a committed owner notification in its own bubble when the agent continues the active turn', () => {
    const notification: ChatMessage = { ...message('owner-notify', 'assistant', 3000), ownerNotification: {
      requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 't',
    } };
    const record = turn([message('u', 'user', 1000), call('send'), notification, call('continued'), message('later', 'assistant', 5000)]);
    for (const active of [true, false]) {
      const blocks = planConversationSegments(record, active).filter(block => block.kind === 'segment');
      expect(blocks.map(segment => conversationOutput(segment.items).reply?.id)).toEqual(['owner-notify', 'later']);
      const rows = flattenTier([record], context(active), segmenters);
      expect((rows.find(row => row.itemId === notification.id)!.data as ChatMessage).conversationNarration).toBeUndefined();
    }
  });
  it('uses attachment labels in an explicit native quote without changing the input or its anchor', () => {
    const text = '看下文件\n@[tri19-file.txt](/Users/host/task-attachments/c/tri19-file.txt)';
    const input = { ...message('u', 'user'), text };
    const target = { kind: 'session' as const, sessionId: 's', itemId: 'u' };
    const answer = { ...message('answer', 'assistant'), text: messageQuoteText(target, text, 'Peer') + 'answer' };
    const record = turn([input, answer]);
    const rows = flattenTier([record], context(false), segmenters);
    const reply = rows.find(row => row.itemId === 'answer')!.data as ChatMessage;
    expect(reply.conversationReply).toMatchObject({ itemId: messageQuoteLink(target), text: '看下文件\ntri19-file.txt' });
    expect(input.text).toBe(text);
  });

  it('starts a new Stop segment at the authentic hook clock, preserving both replies', () => {
    const hook: ChatItem = { kind: 'session-notice', id: 'stop', seq: 3, code: 'provider-notice', title: 'Stop says: Check.', detail: 'Stop says: Check.', at: 4000 };
    const blocks = planConversationSegments(turn([message('u', 'user', 1000), call('one'), message('before', 'assistant', 3000), hook, call('two'), message('after', 'assistant', 7000)]), false);
    const segments = blocks.filter(block => block.kind === 'segment');
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ id: 't:process', startedAt: 1000, endedAt: 3000 });
    expect(segments[1]).toMatchObject({ id: 't:process@stop', startedAt: 4000, endedAt: 9000 });
    expect(segments.map(segment => conversationOutput(segment.items).reply?.id)).toEqual(['before', 'after']);
    expect(segments[1].items.map(item => item.id)).toEqual(['stop', 'two', 'after']);
  });

  it('keeps the latest live words in a bubble and earlier words in the process', () => {
    const record = turn([message('u', 'user'), call('one'), message('first', 'assistant'), call('two'), message('latest', 'assistant')]);
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.map(row => row.itemId)).toEqual(['t:day', 'u', 't:process:head', 't:run:one', 'first', 't:run:two', 'latest']);
    expect((rows.find(row => row.itemId === 'latest')!.data as ChatMessage).conversationNarration).toBeUndefined();
    expect(rows.find(row => row.itemId === 'latest')!.data).not.toHaveProperty('conversationCaret');
    expect((rows.find(row => row.itemId === 'first')!.data as ChatMessage).conversationNarration).toBe(true);
  });

  it('seals the entire pre-steer block above the input, both live and settled', () => {
    const record = turn([message('u', 'user', 1000), message('first', 'assistant', 2000), call('work'),
      message('ready', 'assistant', 4000), message('steer', 'user', 5000), call('after'), message('next', 'assistant', 7000)]);
    for (const active of [true, false]) {
      const rows = flattenTier([record], context(active, ['t:process']), segmenters);
      const ids = rows.map(row => row.itemId);
      expect(ids.indexOf('first')).toBeLessThan(ids.indexOf('ready'));
      expect(ids.indexOf('t:process:head')).toBeLessThan(ids.indexOf('ready'));
      expect(ids.indexOf('ready')).toBeLessThan(ids.indexOf('steer'));
      expect(ids.indexOf('steer')).toBeLessThan(ids.indexOf('t:process@steer:head'));
      const before = rows.find(row => row.itemId === 't:process:head')!.data as ChatMessage;
      expect(before.conversationProcess).toMatchObject({ startedAt: 1000, endedAt: 5000 });
      expect(before.conversationProcess?.live).toBeUndefined();
      const after = rows.find(row => row.itemId === 't:process@steer:head')!.data as ChatMessage;
      expect(after.conversationProcess?.startedAt).toBe(5000);
    }
  });

  it('creates one zero-body process line immediately after a steer and attaches background there', () => {
    const record = turn([message('u', 'user', 1000), message('ready', 'assistant', 2000), message('steer', 'user', 5000)]);
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.at(-1)?.itemId).toBe('t:process@steer');
    expect(rows.at(-1)?.data).toMatchObject({ kind: 'turn-process', live: true, placeholder: true, startedAt: 5000 });
    expect(conversationBackgroundOwner(rows)).toBe('t:process@steer');
    expect(rows.some(row => row.kind === 'background-tasks')).toBe(false);
  });

  // #2587 (owner 2026-11-13):「三类消息之前是会创建新的气泡段落，现在是接续之前气泡段落」.
  it('continues the segment across a notification: one process line, the earlier words fold, background owner stays', () => {
    const record = turn([message('u', 'user', 1000), message('before', 'assistant', 2000), notice('done', 5000), message('woken', 'assistant', 6000)]);
    const rows = flattenTier([record], context(false, ['t:process']), segmenters);
    expect(rows.filter(row => (row.data as ChatMessage).conversationPart === 'head').map(row => row.itemId)).toEqual(['t:process:head']);
    const head = rows.find(row => row.itemId === 't:process:head')!.data as ChatMessage;
    expect(head.conversationProcess).toMatchObject({ startedAt: 1000, endedAt: 9000, steps: 0 });
    expect((rows.find(row => row.itemId === 'before')!.data as ChatMessage).conversationNarration).toBe(true);
    expect(rows.find(row => row.itemId === 't:run:done')!.data).toMatchObject({ kind: 'tool-run', label: '1 subagent finished' });
    expect((rows.find(row => row.itemId === 'woken')!.data as ChatMessage).conversationPart).toBe('body');
    expect(conversationBackgroundOwner(rows)).toBe(head.id);
    expect(rows.some(row => row.kind === 'background-tasks')).toBe(false);
  });

  it('folds a notification into the running segment between the work before it and the following reply', () => {
    const blocks = planConversationSegments(turn([message('u', 'user'), call('one'), notice('done', 3000), message('reply', 'assistant')]), true);
    expect(blocks.map(block => block.kind === 'input' ? block.item.id : block.items.map(item => item.id))).toEqual(['u', ['one', 'done', 'reply']]);
  });

  it('seals a successful projected send and keeps later work in another segment', () => {
    const sent = message('send:sent:confirmed', 'assistant', 4000);
    const blocks = planConversationSegments(turn([message('u', 'user', 1000), message('first', 'assistant', 2000), sent, call('after')]), true);
    const segments = blocks.filter(block => block.kind === 'segment');
    expect(segments).toHaveLength(2);
    expect(conversationOutput(segments[0].items, true).reply?.id).toBe(sent.id);
    expect(segments[0]).toMatchObject({ live: false, endedAt: 4000 });
    expect(segments[1], 'the live line counts only work after the send').toMatchObject({ live: true, startedAt: 4000 });
  });

  it('counts the first process line from the turn origin even if the first message arrived later', () => {
    // The turn's clock is the send; the prompt reached the runtime 2 s later (a session that was starting).
    const [segment] = planConversationSegments(turn([message('u', 'user', 3000)]), true).filter(block => block.kind === 'segment');
    expect(segment).toMatchObject({ live: true, startedAt: 1000 });
    const closed = planConversationSegments({ ...turn([message('u', 'user', 3000), message('reply', 'assistant', 4000)]) }, false).filter(block => block.kind === 'segment');
    expect(closed[0]).toMatchObject({ startedAt: 1000 });
  });

  it('keeps an active process after a lone completion, the completion folded into it, without a quote', () => {
    const source = notice('wake', 5000);
    const rows = flattenTier([turn([source])], context(true), segmenters);
    expect(rows.map(row => row.itemId)).toEqual(['t:day', 't:process', 't:run:wake']);
    expect(rows[1]?.data).toMatchObject({ kind: 'turn-process', live: true, startedAt: 1000 });
    expect(rows.some(row => (row.data as ChatMessage).conversationReply)).toBe(false);
  });

  it.each(['background-command-done-tool-call', 'subagent-done-tool-call'] as const)(
    'keeps an untimed %s from inventing a completed reply clock', kind => {
      const base = { id: 'wake', seq: 1, toolCallId: 'wake', launchToolCallId: 'launch',
        title: 'wake', name: 'wake', status: 'done' as const, outcome: 'completed' as const };
      const source: ChatItem = kind === 'subagent-done-tool-call' ? { ...base, kind, agentId: 'child' } : { ...base, kind };
      for (const active of [false, true]) {
        for (const at of [undefined, 5000]) {
          const record = turn([message('input', 'user'), { ...source, at }, message('reply', 'assistant')]);
          // The segment opened with the input; the completion inside it brings no clock of its own (#2587).
          const [segment] = planConversationSegments(record, active).filter(block => block.kind === 'segment');
          expect(segment.startedAt).toBe(1000);
          const rows = flattenTier([record], context(active), segmenters);
          const head = rows.find(row => (row.data as ChatMessage).conversationPart === 'head')!.data as ChatMessage;
          expect(head.conversationProcess).toMatchObject({ steps: 0 });
          expect(head.conversationProcess?.startedAt).toBe(1000);
        }
      }
    },
  );

  it('excludes silence and the visible reply without dropping earlier live parts', () => {
    const record = turn([message('u', 'user'), call('one'), message('a', 'assistant'), call('two'), message('b', 'assistant'), call('three'), message('latest', 'assistant'), { ...message('silent', 'assistant'), text: '[NO_REPLY]' }]);
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.map(row => row.itemId)).not.toContain('t:process:earlier');
    expect(rows.map(row => row.itemId)).toContain('t:run:one');
    expect(rows.map(row => row.itemId)).toContain('a');
    expect(rows.map(row => row.itemId)).not.toContain('silent');
    expect(rows.filter(row => row.itemId === 'latest')).toHaveLength(1);
    expect(rows.find(row => row.itemId === 'latest')!.data).not.toHaveProperty('conversationCaret');
  });

  it('does not infer process labels from runtime triggers or invent historical clocks', () => {
    const record: TranscriptTurn = { ...turn([message('u', 'user'), message('reply', 'assistant')]), startedAt: undefined, endedAt: undefined, trigger: { kind: 'schedule' } };
    const rows = flattenTier([record], context(true), segmenters);
    const head = rows.find(row => (row.data as ChatMessage).conversationPart === 'head')!.data as ChatMessage;
    expect(head.conversationProcess).not.toHaveProperty('trigger');
    expect(head.conversationProcess?.startedAt).toBeUndefined();
    expect(head.conversationProcess?.endedAt).toBeUndefined();
  });

  it('keeps an observable placeholder before scheduled model output arrives', () => {
    const record = { ...turn([]), initiator: 'agent' as const, trigger: { kind: 'schedule' as const } };
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.at(-1)?.data).toMatchObject({ kind: 'turn-process', live: true,
      placeholder: true, startedAt: 1000, steps: 0 });
  });

  it('does not expose trigger labels when later input comes from another source', () => {
    const incoming = { ...message('delivery', 'user', 8000), text: '<gugu_delivery route="chat" from="Peer" from_id="user:11111111-1111-4111-8111-111111111111" chat="206258" chat_kind="group" source_link="gugu-chat://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333"><![CDATA[update]]></gugu_delivery>' };
    const record = { ...turn([message('before', 'assistant', 2000), message('owner', 'user', 5000)]), initiator: 'agent' as const, trigger: { kind: 'agent' as const } };
    let rows = flattenTier([record], context(true), segmenters);
    expect(rows.at(-1)?.data).not.toHaveProperty('trigger');
    record.items = [...record.items, message('after', 'assistant', 6000), incoming] as TranscriptTurn['items'];
    rows = flattenTier([record], context(true), segmenters);
    expect(rows.at(-1)?.data).not.toHaveProperty('trigger');
    const old = rows.find(row => row.itemId === 't:process:head')!.data as ChatMessage;
    expect(old.conversationProcess).not.toHaveProperty('trigger');
  });

  it('folds a completion without a summary into the process, without quoting it', () => {
    const record = turn([message('before', 'assistant', 2000), notice('wake', 5000), message('after', 'assistant', 6000)]);
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.filter(row => (row.data as ChatMessage).conversationPart === 'head').map(row => row.itemId)).toEqual(['t:process:head']);
    const head = rows.find(row => row.itemId === 't:process:head')!.data as ChatMessage;
    expect(head.conversationReply).toBeUndefined();
    expect(rows.some(row => row.itemId === 'wake')).toBe(false);
    expect(rows.find(row => row.itemId === 't:run:wake')?.data).toMatchObject({ kind: 'tool-run' });
    expect(head.conversationProcess).not.toHaveProperty('trigger');
  });

  it.each([
    ['command', 'completed'], ['command', 'failed'], ['command', 'stopped'],
    ['subagent', 'completed'], ['subagent', 'failed'], ['subagent', 'stopped'],
  ] as const)('folds the %s %s event into the process above the following reply', (kind, outcome) => {
    const base = { id: 'wake', toolCallId: 'wake', seq: 1, title: 'cd /tmp/raw-command && export PATH=fixture; echo RAW-WAKE-991',
      name: 'RAW-WAKE-991', status: 'done' as const, launchToolCallId: 'launch', outcome, at: 5000 };
    const source: ChatItem = kind === 'command' ? { ...base, kind: 'background-command-done-tool-call' }
      : { ...base, kind: 'subagent-done-tool-call', agentId: 'child' };
    for (const active of [false, true]) {
      // Expanded down to the step (a live process is open by default): the event itself is still there, unchanged.
      const rows = flattenTier([turn([source, message('after', 'assistant', 6000)])], context(active, active ? ['t:run:wake'] : ['t:process', 't:run:wake']), segmenters);
      const head = rows.find(row => (row.data as ChatMessage).conversationPart === 'head')!.data as ChatMessage;
      expect(head.conversationReply).toBeUndefined();
      expect(rows.find(row => row.itemId === 'wake')?.data).toEqual(source);
      expect(rows.findIndex(row => row.itemId === head.id)).toBeLessThan(rows.findIndex(row => row.itemId === 'wake'));
      expect(rows.findIndex(row => row.itemId === 'wake')).toBeLessThan(rows.findIndex(row => row.itemId === 'after'));
    }
  });

  it.each([false, true])('never infers quotes from inputs, steers, sends or Stop boundaries (active: %s)', active => {
    const stop: ChatItem = { kind: 'session-notice', id: 'stop', seq: 3, code: 'provider-notice', title: 'Stop says: Check.', detail: 'Stop says: Check.', at: 4000 };
    const record = turn([message('u', 'user', 1000), message('first', 'assistant', 2000),
      message('steer', 'user', 3000), message('second', 'assistant', 3500), stop,
      message('after-stop', 'assistant', 5000), message('send:sent:confirmed', 'assistant', 6000), message('after-send', 'assistant', 7000)]);
    const heads = flattenTier([record], context(active), segmenters).filter(row => (row.data as ChatMessage).conversationPart === 'head');
    expect(heads).toHaveLength(4);
    for (const row of heads) expect((row.data as ChatMessage).conversationReply).toBeUndefined();
  });

  it.each(['native', 'delivery', 'sent'] as const)('preserves an explicit %s reply anchor through flattening', source => {
    const original = { ...message('original', 'user'), text: '<gugu_delivery route="chat" msg="msg:remote" from="Peer" from_id="user:peer"><![CDATA[original words]]></gugu_delivery>' };
    const text = source === 'native' ? messageQuoteText({ kind: 'session', sessionId: 's', itemId: 'original' }, 'original words', 'Peer') + 'reply'
      : source === 'delivery' ? '<gugu_delivery route="chat" from="Peer" from_id="user:peer"><reply_to msg="msg:remote" from_id="user:peer"><![CDATA[original words]]></reply_to><![CDATA[reply]]></gugu_delivery>' : 'reply';
    const reply = { ...message('reply', source === 'delivery' ? 'user' : 'assistant'), text, ...(source === 'sent' ? { sentReplyTo: 'remote' } : {}) };
    const rows = flattenTier([turn([original, reply])], context(false), segmenters);
    const quote = rows.map(row => (row.data as ChatMessage).conversationReply).find(Boolean);
    expect(quote).toMatchObject({ itemId: source === 'native' ? messageQuoteLink({ kind: 'session', sessionId: 's', itemId: 'original' }) : 'original', text: 'original words', from: 'Peer' });
  });

  it('does not add the generic message margin between process parts or after an action lane', () => {
    const record = turn([message('u', 'user', 1000), call('work'), message('first', 'assistant', 2000), call('more'), message('latest', 'assistant', 3000), message('steer', 'user', 4000)]);
    const rows = flattenTier([record], context(true, ['t:process']), segmenters);
    expect(rows.find(row => row.itemId === 'first')?.gapBefore).toBe(0);
    expect(rows.find(row => row.itemId === 'latest')?.gapBefore).toBe(8);
    expect(rows.find(row => row.itemId === 'steer')?.gapBefore).toBe(0);
    expect(rows.at(-1)?.gapBefore).toBe(0);
  });

  it('uses the real turn completion after a zero-tool reply whose first chunk arrived at wake-up', () => {
    const record: TranscriptTurn = { ...turn([message('woken', 'assistant', 1000)]), initiator: 'agent', endedAt: 3500 };
    const rows = flattenTier([record], context(false), segmenters);
    const head = rows.find(row => (row.data as ChatMessage).conversationPart === 'head')!.data as ChatMessage;
    expect(head.conversationProcess).toMatchObject({ startedAt: 1000, endedAt: 3500, steps: 0, empty: true });
  });

  it.each(['running', 'error'] as const)('keeps a %s send in the steps without a second reply bubble or segment', status => {
    const record = turn([message('ready', 'assistant', 2000), { kind: 'mcp-tool-call', id: 'pending', seq: 1,
      toolCallId: 'pending', title: 'message_send', server: 'plugin_gugu-product_gugu', tool: 'message_send',
      status, rawInput: JSON.stringify({ chat_id: 'elsewhere', text: 'unconfirmed' }), at: 3000 }]);
    const rows = flattenTier([record], context(true), segmenters);
    expect(rows.some(row => row.kind === 'agent-send')).toBe(false);
    expect(rows.filter(row => (row.data as ChatMessage).conversationPart === 'head')).toHaveLength(1);
    expect(rows.find(row => row.itemId === 't:run:pending')?.data).toMatchObject({ kind: 'tool-run', stepCount: 1, label: 'Called 1 MCP tool' });
    expect(rows.some(row => row.kind === 'mcp-tool-call')).toBe(false);
    expect(rows.filter(row => (row.data as ChatMessage).conversationPart === 'body').map(row => row.itemId)).toEqual(['ready']);
  });
});

// #2587, owner 2026-11-13:「三类消息之前是会创建新的气泡段落，现在是接续之前气泡段落」
// 「但是比如 A2A 消息或者用户消息造成的分割，还是会分割消息气泡」
describe('subagent / background command completions and compaction continue the segment (#2587)', () => {
  const DONE = { kind: 'done' } as TranscriptTurn['outcome'];
  const answered: TranscriptTurn = { id: 'p', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 4000, outcome: DONE,
    items: [message('u', 'user', 1000), call('c1'), message('answer', 'assistant', 3000)] as TranscriptTurn['items'] };
  const woken = (over: Partial<TranscriptTurn> = {}): TranscriptTurn => ({ id: 'w', seq: 1, initiator: 'agent', trigger: { kind: 'agent' },
    startedAt: 60000, endedAt: 65000, outcome: DONE, items: [notice('n1', 60000), call('c2'), message('later', 'assistant', 64000)] as TranscriptTurn['items'], ...over });
  const heads = (rows: ReturnType<typeof flattenTier>) => rows.filter(row => (row.data as ChatMessage).conversationPart === 'head');
  const bodies = (rows: ReturnType<typeof flattenTier>) => rows.filter(row => (row.data as ChatMessage).conversationPart === 'body').map(row => row.itemId);
  const compaction = (id: string, at: number, status: 'completed' | 'failed' = 'completed'): ChatItem =>
    ({ kind: 'compaction', id, seq: 0, compactionId: id, status, summary: '', startedAt: at } as unknown as ChatItem);

  it('joins an agent turn woken by a completion onto the answered turn: one line, idle time excluded, latest answer is the bubble', () => {
    const rows = flattenTier([answered, woken()], context(false, ['p:process']), segmenters);
    expect(heads(rows).map(row => row.itemId)).toEqual(['p:process:head']);
    // 3 s before the wake + 5 s after it; the 56 s it sat idle in between is not work.
    expect((heads(rows)[0]!.data as ChatMessage).conversationProcess).toMatchObject({ startedAt: 1000, endedAt: 65000, idleMs: 56000, steps: 2 });
    expect((rows.find(row => row.itemId === 'answer')!.data as ChatMessage).conversationNarration).toBe(true);
    expect(bodies(rows)).toEqual(['later']);
    expect(rows.some(row => row.itemId === 'n1')).toBe(false);
  });

  it('shows the joined turn live on the process line already on screen while the woken turn runs', () => {
    const live = { ...woken(), endedAt: undefined, outcome: undefined };
    const projected = withContinuedActiveTurn({ committed: [answered], active: live });
    expect(projected.committed).toEqual([]);
    expect(projected.active?.id).toBe('p');
    const rows = flattenTier([projected.active!], context(true), segmenters);
    expect(heads(rows).map(row => row.itemId)).toEqual(['p:process:head']);
    // Opened and closed under a key of its own while it runs again; back under its id once the run is over.
    expect((heads(rows)[0]!.data as ChatMessage).conversationProcess).toMatchObject({ live: true, startedAt: 1000, idleMs: 56000, toggleId: 'p:process~n1' });
    expect(bodies(rows)).toEqual(['later']);
    const settled = flattenTier([answered, woken()], context(false), segmenters);
    expect((heads(settled)[0]!.data as ChatMessage).conversationProcess?.toggleId).toBeUndefined();
  });

  it('gives a whole run of continued turns back to the live tier, and nothing when the last turn did not end cleanly', () => {
    const second = woken({ id: 'w2', seq: 2, startedAt: 70000, endedAt: 71000, items: [notice('n2', 70000)] as TranscriptTurn['items'] });
    const live = { ...woken({ id: 'w3', seq: 3, startedAt: 80000 }), endedAt: undefined, outcome: undefined };
    expect(withContinuedActiveTurn({ committed: [answered, woken(), second], active: live }).committed).toEqual([]);
    const stopped = { ...answered, outcome: { kind: 'cancelled', reason: 'cancelled' } as TranscriptTurn['outcome'] };
    expect(withContinuedActiveTurn({ committed: [stopped], active: live }).committed).toEqual([stopped]);
    expect(joinContinuedTurns([stopped, woken()])).toHaveLength(2);
  });

  it.each([
    ['a user message', { initiator: 'user' as const, trigger: { kind: 'owner' as const } }],
    ['an A2A / group delivery', { trigger: { kind: 'delivery' as const, chatIds: ['206258'] } }],
    ['a schedule', { trigger: { kind: 'schedule' as const } }],
  ])('still splits on a turn opened by %s', (_name, over) => {
    const rows = flattenTier([answered, woken(over)], context(false), segmenters);
    expect(heads(rows).map(row => row.itemId)).toEqual(['p:process:head', 'w:process:head']);
    expect(bodies(rows)).toEqual(['answer', 'later']);
  });

  it('still splits on a user message inside the turn', () => {
    const record = turn([message('u', 'user', 1000), call('one'), message('first', 'assistant', 2000), notice('n', 3000),
      message('steer', 'user', 4000), call('two'), message('second', 'assistant', 6000)]);
    const rows = flattenTier([record], context(false), segmenters);
    expect(heads(rows)).toHaveLength(2);
    expect(bodies(rows)).toEqual(['first', 'second']);
  });

  it('folds a mid-run compaction into the process line and says so; a failed one keeps its own row', () => {
    const record = turn([message('u', 'user', 1000), call('c1'), message('mid', 'assistant', 2000), compaction('cp', 4000), call('c2'), message('end', 'assistant', 6000)]);
    const rows = flattenTier([record], context(false, ['t:process']), segmenters);
    expect(heads(rows)).toHaveLength(1);
    expect(bodies(rows)).toEqual(['end']);
    expect(rows.some(row => row.itemId === 'cp')).toBe(false);
    expect(rows.find(row => row.itemId === 't:run:cp')?.data).toMatchObject({ label: 'Ran 1 shell command, compacted the context 1 time' });
    const failed = turn([message('u', 'user', 1000), call('c1'), message('mid', 'assistant', 2000), compaction('cp', 4000, 'failed'), call('c2'), message('end', 'assistant', 6000)]);
    const failedRows = flattenTier([failed], context(false), segmenters);
    expect(heads(failedRows)).toHaveLength(2);
    expect(failedRows.some(row => row.itemId === 'cp')).toBe(true);
  });
});
