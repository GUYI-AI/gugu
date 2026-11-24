import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./turn-files', () => ({ prefetchFiles: vi.fn() }));

vi.mock('../sessions/session-conversation-read', () => ({
  markNativeConversationVisible: vi.fn(), nativeConversationUnread: () => [], nativeOwnerNotificationUnread: () => [],
}));

const state = vi.hoisted(() => ({
  emits: [] as Array<{ name: string; data: unknown; topic?: string }>,
  pushes: new Map<string, (event: unknown) => void>(),
  legacyStarts: vi.fn(),
  unsubscribe: vi.fn(),
  unsubscribeSessions: vi.fn(),
  unwatch: vi.fn(),
  /** 设了就让订阅停在「等底」那一步,直到测试放行。 */
  gate: null as null | Promise<void>,
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: (event: { name: string }, data: unknown, topic?: string) => state.emits.push({ name: event.name, data, topic }) },
}));
vi.mock('./task-exchanges', () => ({
  readTaskExchanges: () => ({ entries: [], cursor: 0, hasMore: false }),
  watchTaskExchanges: (id: string, _request: unknown, changed: () => void) => state.pushes.set(id, changed),
  unwatchTaskExchanges: (id: string) => state.unwatch(id),
}));
vi.mock('./create-session', () => ({
  createSession: async () => ({ ok: true, value: { conversationId: 'c-new', projectId: 'p', title: 'hi' } }),
}));
vi.mock('./service', () => ({
  nativeAttachment: vi.fn(),
  snapshot: async () => ({ ok: true, value: { cursor: { epoch: 'e', seq: 1 }, turns: [turnWith(HUGE)], settlements: [], hasOlder: false } }),
  // A cursor of another epoch (the host restarted): the answer is a reset with a new snapshot.
  after: async () => ({ ok: true, value: { ok: false, reset: 'epoch_changed', snapshot: { cursor: { epoch: 'e2', seq: 1 }, turns: [turnWith(HUGE)], settlements: [], hasOlder: false } } }),
  subscribe: async (input: { subscriptionId: string }, emit: (event: unknown) => void) => {
    state.legacyStarts(input.subscriptionId);
    state.pushes.set(input.subscriptionId, emit);
    return { ok: true, value: { subscriptionId: input.subscriptionId } };
  },
  unsubscribe: (...args: unknown[]) => state.unsubscribe(...args),
  subscribeSessions: async (id: string, emit: (event: unknown) => void) => {
    if (state.gate) await state.gate;
    state.pushes.set(id, emit);
    return { ok: true, value: { subscriptionId: id } };
  },
  unsubscribeSessions: (...args: unknown[]) => state.unsubscribeSessions(...args),
  sessionSummary: (id: string) => ({ conversationId: id, title: 'hi' }),
}));

const HUGE = 'x'.repeat(20_000);
function turnWith(outputText: string) {
  return {
    id: 't1', role: 'assistant', startedAt: 1, outcome: null, itemIds: ['a'],
    items: [{ kind: 'execute-tool-call', id: 'a', seq: 1, toolCallId: 'a', title: 'cat', status: 'done', outputText }],
  };
}

const { sessionTimelineController, releaseSubscriptionsOf } = await import('./controller');
const { registerRPCRouter } = await import('@shared/lib/ipc/rpc');

/** 经注册器调(与宿主同一条路):sender 由注册器从事件里取。 */
const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>();
registerRPCRouter({ sessionTimeline: sessionTimelineController }, { handle: (channel, listener) => handlers.set(channel, listener) });
const call = (sender: number, method: string, ...args: unknown[]) => handlers.get(`sessionTimeline.${method}`)!({ sender: { id: sender } }, ...args);

const outputOf = (value: unknown) => (value as { turns: Array<{ items: Array<{ outputText: string }> }> }).turns[0]!.items[0]!.outputText;

beforeEach(() => {
  state.emits = [];
  state.pushes.clear();
  state.legacyStarts.mockClear();
  state.unsubscribe = vi.fn();
  state.unsubscribeSessions = vi.fn();
  state.unwatch = vi.fn();
  state.gate = null;
});

describe('会话时间线路由(本机、别的电脑、手机同一张)', () => {
  it('preserves the existing cross-connection legacy reconnect selection', async () => {
    const input = { conversationId: 'legacy', subscriptionId: 'legacy-reconnect', cursor: null };
    await expect(call(812, 'sessionSubscribe', input)).resolves.toMatchObject({ ok: true });
    await expect(call(813, 'sessionSubscribe', input)).resolves.toMatchObject({ ok: true });
    expect(state.legacyStarts).toHaveBeenCalledTimes(2);
    releaseSubscriptionsOf(812); releaseSubscriptionsOf(813);
  });
  it('task exchange subscriptions are scoped to the requesting connection and released with it', async () => {
    await call(700, 'taskExchangesSubscribe', { conversationId: 'task', fromSessionId: 'assistant', subscriptionId: 'exchange-a' });
    await call(701, 'taskExchangesUnsubscribe', { subscriptionId: 'exchange-a' });
    expect(state.unwatch).not.toHaveBeenCalled();
    state.pushes.get('700:exchange-a')!({});
    expect(state.emits.at(-1)).toMatchObject({ name: 'session:task-exchanges', topic: 'exchange-a' });
    releaseSubscriptionsOf(700);
    expect(state.unwatch).toHaveBeenCalledWith('700:exchange-a');
  });
  it('推送按订阅号发(topic = subscriptionId),❌ 一件事推给每条线', async () => {
    await call(1_000_001, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'sub-1', cursor: null });
    state.pushes.get('sub-1')!({ subscriptionId: 'sub-1', result: { ok: true, batch: { turns: [] } } });
    expect(state.emits).toEqual([{ name: 'session-timeline:push', topic: 'sub-1', data: expect.objectContaining({ subscriptionId: 'sub-1' }) }]);
  });

  it('trim 只给要它的调用方:手机拿到裁过的,桌面一个字不裁(快照与推送同一条)', async () => {
    const full = (await call(1, 'sessionSnapshot', { conversationId: 'c1' })) as { value: unknown };
    expect(outputOf(full.value)).toHaveLength(20_000);
    const trimmed = (await call(1_000_001, 'sessionSnapshot', { conversationId: 'c1', trim: true })) as { value: unknown };
    expect(outputOf(trimmed.value)).toHaveLength(8_192);

    await call(1_000_001, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'sub-t', cursor: null, trim: true });
    await call(1, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'sub-f', cursor: null });
    for (const id of ['sub-t', 'sub-f']) {
      state.pushes.get(id)!({ subscriptionId: id, result: { ok: true, batch: { from: 0, cursor: { epoch: 'e', seq: 2 }, removedTurnIds: [], settlements: [], turns: [turnWith(HUGE)] } } });
    }
    const pushed = (topic: string) => (state.emits.find((e) => e.topic === topic)!.data as { result: { batch: unknown } }).result.batch;
    expect(outputOf(pushed('sub-t'))).toHaveLength(8_192);
    expect(outputOf(pushed('sub-f'))).toHaveLength(20_000);
  });

  it('lean: a reader that asks for folded pages gets them folded; one that does not ask gets them as before', async () => {
    const page = async (input: object) => ((await call(1_000_001, 'sessionSnapshot', { conversationId: 'c1', trim: true, ...input })) as { value: { turns: Array<{ items: Array<Record<string, unknown>> }> } }).value.turns[0]!.items[0]!;
    const folded = await page({ lean: 'folded' });
    expect(folded).toMatchObject({ id: 'a', held: true });
    expect(folded.outputText).toBeUndefined();
    const whole = await page({});
    expect(whole.held).toBeUndefined();
    expect(whole.outputText).toHaveLength(8_192);
    // Without `trim` nothing is trimmed, folded or not: the local page reads whole.
    expect(outputOf(((await call(1, 'sessionSnapshot', { conversationId: 'c1', lean: 'folded' })) as { value: unknown }).value)).toHaveLength(20_000);
  });

  it('lean: the snapshot of a reset answer (after, or a subscribe push) is folded when asked, whole when not', async () => {
    const after = async (input: object) => ((await call(1_000_001, 'sessionAfter', { conversationId: 'c1', cursor: { epoch: 'e', seq: 1 }, trim: true, ...input })) as
      { value: { snapshot: { turns: Array<{ items: Array<Record<string, unknown>> }> } } }).value.snapshot.turns[0]!.items[0]!;
    expect(await after({ lean: 'folded' })).toMatchObject({ id: 'a', held: true });
    expect((await after({})).held).toBeUndefined();

    await call(1_000_001, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'sub-lean', cursor: null, trim: true, lean: 'folded' });
    state.pushes.get('sub-lean')!({ subscriptionId: 'sub-lean', result: { ok: false, reset: 'epoch_changed', snapshot: { cursor: { epoch: 'e2', seq: 1 }, turns: [turnWith(HUGE)], settlements: [], hasOlder: false } } });
    const pushed = state.emits.find((e) => e.topic === 'sub-lean')!.data as { result: { snapshot: { turns: Array<{ items: Array<Record<string, unknown>> }> } } };
    expect(pushed.result.snapshot.turns[0]!.items[0]).toMatchObject({ id: 'a', held: true });
  });

  it('订阅归开它的那条线:线断了一并拆(时间线与会话列表),别的线开的不动;退订过的不再拆第二次', async () => {
    await call(3_000_001, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'phone-1', cursor: null });
    await call(3_000_001, 'sessionSubscribe', { conversationId: 'c2', subscriptionId: 'phone-2', cursor: null });
    await call(3_000_001, 'sessionsSubscribe', { subscriptionId: 'phone-list' });
    await call(3_000_002, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'desk-1', cursor: null });
    await call(3_000_001, 'sessionUnsubscribe', { subscriptionId: 'phone-2' });
    expect(state.unsubscribe.mock.calls.map(([id]) => id)).toEqual(['phone-2']);

    releaseSubscriptionsOf(3_000_001);
    expect(state.unsubscribe.mock.calls.map(([id]) => id)).toEqual(['phone-2', 'phone-1']);
    expect(state.unsubscribeSessions.mock.calls.map(([id]) => id)).toEqual(['phone-list']);
    // 再报一次同一条线断了:已经没有它名下的了。
    releaseSubscriptionsOf(3_000_001);
    expect(state.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('退订只拆自己开的:别的线(含一问一答)拿着订阅号也退不掉', async () => {
    await call(4_000_001, 'sessionSubscribe', { conversationId: 'c1', subscriptionId: 'mine', cursor: null });
    await call(4_000_001, 'sessionsSubscribe', { subscriptionId: 'mine-list' });
    await call(4_000_002, 'sessionUnsubscribe', { subscriptionId: 'mine' });
    await call(4_000_002, 'sessionsUnsubscribe', { subscriptionId: 'mine-list' });
    expect(state.unsubscribe).not.toHaveBeenCalled();
    expect(state.unsubscribeSessions).not.toHaveBeenCalled();
    // 对照:自己退得掉
    await call(4_000_001, 'sessionUnsubscribe', { subscriptionId: 'mine' });
    await call(4_000_001, 'sessionsUnsubscribe', { subscriptionId: 'mine-list' });
    expect(state.unsubscribe.mock.calls.map(([id]) => id)).toEqual(['mine']);
    expect(state.unsubscribeSessions.mock.calls.map(([id]) => id)).toEqual(['mine-list']);
  });

  it('新建交回这条会话在列表里的那一行(与 sessionsList 同一个投影)', async () => {
    expect(await call(1_000_001, 'sessionCreate', { harness: 'claude', prompt: 'hi', projectId: 'p' })).toEqual({
      ok: true,
      value: { conversationId: 'c-new', projectId: 'p', title: 'hi', session: { conversationId: 'c-new', title: 'hi' } },
    });
  });
});

describe('订阅在等的时候就记在线名下(复核 138)', () => {
  it('等底期间线断了:拆得到这一条(❌ 订成之后才记,给死掉的线留孤儿)', async () => {
    let open: () => void = () => undefined;
    state.gate = new Promise((resolve) => { open = resolve; });
    const pending = call(5_000_001, 'sessionsSubscribe', { subscriptionId: 'slow-1' });
    await Promise.resolve();
    releaseSubscriptionsOf(5_000_001);
    expect(state.unsubscribeSessions).toHaveBeenCalledWith('slow-1');
    open();
    await pending;
    // 线已经没了:订成之后也不再记到它名下(再拆一次也拆不到它)。
    state.unsubscribeSessions.mockClear();
    releaseSubscriptionsOf(5_000_001);
    expect(state.unsubscribeSessions).not.toHaveBeenCalled();
  });
});
