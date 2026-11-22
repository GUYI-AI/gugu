// @vitest-environment jsdom
/**
 * 不在屏上、也不在最近看过的那几条里的会话,放掉转录(`releaseTranscript` / acp-chat-transcript-keep)。
 *
 * 钉的是:放掉时转录真的空了、活会话照挂;放掉期间提交一轮不去对账(否则又攒回来);
 * 回来时照首次打开那样重读;正在屏上 / 还在加载的不放;只放最近看过的那几条之外的。
 *
 * 桥与动态 import 的写法照 `acp-chat-store.session-absent.test.ts`(那里写了为什么必须这样)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { ChatView } from '@renderer/lib/chat/chat-transcript';
import { host, installAcpChatStoreHost } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');
const { KEPT_HIDDEN_TRANSCRIPTS, forgetTranscriptShown, noteTranscriptShown } = await import(
  './acp-chat-transcript-keep'
);

const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [] }) as unknown as TranscriptTurn;

type Internals = {
  session: unknown;
  _bootstrapped: boolean;
  _history: { opened: boolean };
  _historyGeneration: number;
  _openHistory: (generation: number) => Promise<void>;
  _refreshHistory: () => Promise<void>;
};

let n = 0;
/** 一条已经开过场、转录在手的会话:时间线两轮,画在屏上。 */
async function openedStore(session: unknown) {
  n += 1;
  const store = new AcpChatStore(`conv-release-${n}`, 'proj-1');
  const internals = store as unknown as Internals;
  host.show([turn('s0', 0), turn('s1', 1)]);
  await internals._openHistory(internals._historyGeneration);
  internals._bootstrapped = true;
  internals.session = session;
  store.historyLoading = false;
  host.reads.length = 0;
  return { store, internals };
}

const committedIds = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map((t) => t.id);
const snapshotReads = () => host.reads.filter((read) => read === 'sessionTimeline.sessionSnapshot').length;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  host.reads.length = 0;
});

describe('放掉转录', () => {
  it('转录与时间线都放掉,回来前先是「加载中」;活会话照挂', async () => {
    const session = { getHistory: vi.fn(), activeTurn: { current: () => null } };
    const { store, internals } = await openedStore(session);

    store.releaseTranscript();

    expect(committedIds(store)).toEqual([]);
    expect(internals._history.opened).toBe(false);
    expect(store.historyLoading).toBe(true);
    expect(internals.session).toBe(session);
  });

  it('还在跑的那一轮留着 —— 它提交时旁听口要读它', async () => {
    const { store } = await openedStore({ getHistory: vi.fn(), activeTurn: { current: () => null } });
    store.chatState.transcript.activeTurn.set(turn('live', 2));

    store.releaseTranscript();

    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('live');
  });

  it('放掉期间提交一轮:不对账,时间线与引擎都不读', async () => {
    const session = { getHistory: vi.fn(), activeTurn: { current: () => null } };
    const { store, internals } = await openedStore(session);
    store.releaseTranscript();

    await internals._refreshHistory();

    expect(snapshotReads()).toBe(0);
    expect(session.getHistory).not.toHaveBeenCalled();
    expect(committedIds(store)).toEqual([]);
  });

  it('正挂在屏上、或者还在加载的,不放', async () => {
    const shownOne = (await openedStore({ getHistory: vi.fn(), activeTurn: { current: () => null } })).store;
    shownOne.bindView({} as ChatView);
    shownOne.releaseTranscript();
    expect(committedIds(shownOne)).toEqual(['s0', 's1']);

    const loading = (await openedStore({ getHistory: vi.fn(), activeTurn: { current: () => null } })).store;
    loading.historyLoading = true;
    loading.releaseTranscript();
    expect(committedIds(loading)).toEqual(['s0', 's1']);
  });
});

describe('回来时重读时间线', () => {
  it('活会话还挂着:照挂着,❌ 重挂;只重读时间线', async () => {
    const session = { getHistory: vi.fn(), activeTurn: { current: () => null } };
    const { store, internals } = await openedStore(session);
    store.releaseTranscript();
    const reattach = vi.spyOn(store, 'reattachAfterHostReload').mockImplementation(() => {});
    host.show([turn('s0', 0), turn('s1', 1), turn('s2', 2)]);

    store.bootstrap();
    await flush();

    expect(reattach).not.toHaveBeenCalled();
    expect(snapshotReads()).toBe(1);
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(internals.session).toBe(session);
  });

  it('没有活会话(宿主停了它):只重读时间线,停着的照样停着', async () => {
    const { store, internals } = await openedStore(null);
    store.releaseTranscript();
    host.show([turn('s0', 0), turn('s1', 1), turn('s2', 2)]);

    store.bootstrap();
    await flush();
    await flush();

    expect(snapshotReads()).toBe(1);
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.historyLoading).toBe(false);
    expect(internals.session).toBeNull();
  });
});

describe('只放最近看过的那几条之外的', () => {
  type Fake = { isTransient: boolean; releaseTranscript: ReturnType<typeof vi.fn> };
  const made: Fake[] = [];
  const fake = (isTransient = false): Fake => {
    const store = { isTransient, releaseTranscript: vi.fn() };
    made.push(store);
    return store;
  };
  afterEach(() => {
    for (const store of made.splice(0)) forgetTranscriptShown(store as never);
  });

  it(`当前这条 + 最近 ${KEPT_HIDDEN_TRANSCRIPTS} 条留着,再往前的放掉`, () => {
    const stores = Array.from({ length: KEPT_HIDDEN_TRANSCRIPTS + 3 }, () => fake());
    for (const store of stores) noteTranscriptShown(store as never);

    const released = stores.map((store) => store.releaseTranscript.mock.calls.length > 0);
    expect(released).toEqual(stores.map((_, i) => i < 2));
  });

  it('切回一条旧的:它排到最前,挤出去的是此刻最久没看的那条', () => {
    const stores = Array.from({ length: KEPT_HIDDEN_TRANSCRIPTS + 1 }, () => fake());
    for (const store of stores) noteTranscriptShown(store as never);
    expect(stores.every((store) => store.releaseTranscript.mock.calls.length === 0)).toBe(true);

    noteTranscriptShown(stores[0] as never);
    noteTranscriptShown(fake() as never);

    expect(stores[1]!.releaseTranscript).toHaveBeenCalled();
    expect(stores[0]!.releaseTranscript).not.toHaveBeenCalled();
  });

  it('侧边聊天不进名单 —— 放掉它就没了', () => {
    const side = fake(true);
    noteTranscriptShown(side as never);
    for (let i = 0; i < KEPT_HIDDEN_TRANSCRIPTS + 2; i += 1) noteTranscriptShown(fake() as never);

    expect(side.releaseTranscript).not.toHaveBeenCalled();
  });
});
