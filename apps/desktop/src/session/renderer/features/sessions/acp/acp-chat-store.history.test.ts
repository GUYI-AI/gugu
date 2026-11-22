// @vitest-environment jsdom
/**
 * 历史的接线:回退之后时间线收回那几轮;侧边聊天(没有记录,历史是它的运行时那份)每轮对账只按改动游标取新增 / 改过的
 * 那几轮(@@@history-change-cursor,❌ 一页页重取)、重挂之后状态有没有清、在途请求回来时对不上号有没有丢弃。
 *
 * 桥与动态 import 的写法照 `acp-chat-store.session-absent.test.ts`(那里写了为什么必须这样)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { HistoryCursor } from '@gugu/session-core/acp/client';
import { collectBackgroundCommandRoster } from '@gugu/session-chat-ui';
import { host, installAcpChatStoreHost, replica } from './acp-chat-store.test-host';


vi.mock('@renderer/lib/acp/acp-session-attachment', () => ({
  attachAcpSessionWhenReady: async (id: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    return (await import('@renderer/lib/acp/acp-live-session')).AcpLiveSession.create(id);
  },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const custody = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('./queue-native-input', () => ({ sendThroughCustody: custody, canQueueNativeInput: () => false }));
let resumeSession: unknown = null;
vi.mock('@renderer/lib/acp/acp-live-session', async (original) => ({
  ...(await original<typeof import('@renderer/lib/acp/acp-live-session')>()),
  AcpLiveSession: { create: vi.fn(async () => resumeSession) },
}));

installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');

// `startedAt`: a side chat draws the turns opened in it, not the context replayed into the fork (`sideChatOwnTurns`).
const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', startedAt: 1000 + seq, items: [] }) as unknown as TranscriptTurn;

/**
 * 与运行时 `getHistory` 同一套语义:取 seq < before 的最后 limit 条,由旧到新;取满才给游标。`changedSince` 给了就只回
 * 改动游标之后新增 / 改过的回合。每一轮的改动记号 = 它出现(或被改)的那一次的序号,开头那 count 轮是 1..count。
 */
function fakeRuntime(count: number) {
  const committed = Array.from({ length: count }, (_, seq) => turn(`r${seq}`, seq));
  const revs = committed.map((_, index) => index + 1);
  let rev = count;
  let epoch = 'runtime';
  let oversized = false;
  let pageSize: number | undefined;
  const calls: Array<{ before?: number; changedSince?: HistoryCursor; contentFrom?: number }> = [];
  return {
    calls,
    committed,
    restart() { epoch = 'restarted-runtime'; },
    /** Same epoch, but the changes no longer fit one page: the runtime answers a delta with `reset` (#2493). */
    oversize() { oversized = true; },
    clipPages(size: number) { pageSize = size; },
    append(next: TranscriptTurn) { committed.push(next); revs.push(++rev); },
    revise(index: number, next: TranscriptTurn) { committed[index] = next; revs[index] = ++rev; },
    session: {
      agents: replica([]), config: replica<Record<string, unknown>>({}), plan: replica(null), terminals: replica([]), draft: replica(null),
      activeTurn: replica(null),
      sessionState: replica({ lifecycle: 'ready', isGenerating: false, queuedPrompts: [], pendingPermissions: [] }),
      dispose() {},
      getHistory: (before: number | undefined, limit = 50, changedSince?: HistoryCursor, contentFrom?: number) => {
        calls.push({ before, changedSince, contentFrom });
        const head = { cursor: { epoch, seq: rev }, reset: false, count: committed.length };
        if (changedSince !== undefined) {
          if (changedSince.epoch !== epoch || oversized) return Promise.resolve({ success: true as const, data: { turns: [], nextCursor: null, ...head, reset: true } });
          return Promise.resolve({ success: true as const, data: { turns: committed.filter((_, i) => revs[i]! > changedSince.seq), nextCursor: null, ...head } });
        }
        const filtered = before === undefined ? committed : committed.filter((t) => t.seq < before);
        const requested = filtered.slice(-limit);
        // The RPC can shorten a full page at its transport boundary. Keep an exclusive cursor to omitted turns.
        const page = pageSize === undefined ? requested : requested.slice(-pageSize);
        const nextCursor = page.length < requested.length || requested.length === limit ? page[0]!.seq : null;
        return Promise.resolve({ success: true as const, data: { turns: page, nextCursor, ...head } });
      },
    },
  };
}

type Internals = {
  session: unknown;
  _runtimeCursor: HistoryCursor | null;
  _runtimeCount: number;
  _runtimeTurns: TranscriptTurn[];
  _runtimeWindowStartSeq: number;
  _olderHistoryTurns: TranscriptTurn[];
  _olderCursor: number | null | undefined;
  _historyGeneration: number;
  _openHistory: (generation: number) => Promise<void>;
  _refreshHistory: () => Promise<void>;
  _runBootstrap: (options: { attachOnly: boolean }) => Promise<void>;
  _resetHistoryState: () => void;
  loadOlderHistory: () => Promise<TranscriptTurn[]>;
};

let n = 0;
function makeStore(runtimeView?: ConstructorParameters<typeof AcpChatStore>[2]) {
  n += 1;
  const store = new AcpChatStore(`conv-5381-${n}`, 'proj-1', runtimeView);
  return { store, internals: store as unknown as Internals };
}

/** A side chat: a runtime-only fork, whose history is its runtime's. */
const sideChat = () => makeStore({ id: `side-${n + 1}`, forkFromProviderSessionId: 'native-parent' });

const committedIds = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map((t) => t.id);

beforeEach(() => {
  host.show([]);
  custody.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('#7304 原地回退后的历史对账', () => {
  async function setup(canRevert = true) {
    const { store, internals } = makeStore();
    const turns: TranscriptTurn[] = [0, 1, 2].map((seq) => ({ ...turn(`s${seq}`, seq), items: [
      { kind: 'message' as const, id: `m${seq}`, seq: 0, role: 'user' as const, text: `text-${seq}`, revertAnchor: `native-${seq}` },
    ] }));
    host.show(turns);
    await internals._openHistory(internals._historyGeneration);
    const session = {
      canSyncDraft: () => true,
      activeTurn: { current: () => null },
      setPromptDraft: vi.fn(async () => ({ success: true as const, data: undefined })),
      sessionState: { current: () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: false }) },
      config: { current: () => ({ canRevert }) },
      getHistory: vi.fn(async () => ({ success: true as const, data: { turns: turns.slice(0, 1), nextCursor: null, cursor: { epoch: 'runtime', seq: 1 }, reset: false, count: 1 } })),
      revertSession: vi.fn(async () => {
        // The revert is in the record now: the timeline reads those turns gone.
        host.show(turns.slice(0, 1));
        return { success: true as const, data: { providerSessionId: 'unchanged' } };
      }),
    };
    internals.session = session;
    return { store, internals, session, turns };
  }

  it('裁掉缓存中的未来、恢复原文,后续对账也不复活旧消息', async () => {
    const { store, internals, session } = await setup();
    await store.revertMessage('m1');
    expect(session.revertSession).toHaveBeenCalledWith('native-1', false);
    expect(committedIds(store)).toEqual(['s0']);
    expect(store.draftText).toBe('text-1');
    expect(store.reverting).toBe(false);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0']);
  });

  it('the record names revert points, but an agent that cannot revert offers none', async () => {
    const { store, session } = await setup(false);
    expect(store.canRevertMessage('m1')).toBe(false);
    await store.revertMessage('m1');
    expect(session.revertSession).not.toHaveBeenCalled();
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
  });

  it('底层拒绝时保留当前显示和草稿', async () => {
    const { store, session } = await setup();
    store.setDraftText('draft');
    session.revertSession.mockRejectedValueOnce(new Error('native refusal'));
    await store.revertMessage('m1');
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.draftText).toBe('draft');
    expect(store.reverting).toBe(false);
  });

  it('编辑和取消都不调用原生回退,也不改后续历史或主输入框草稿', async () => {
    const { store, session } = await setup();
    store.setDraftText('main composer draft');
    store.beginMessageEdit('m1');
    expect(store.messageEdit).toEqual({ itemId: 'm1', text: 'text-1' });
    store.changeMessageEdit('m1', 'edited B');
    expect(store.messageEdit?.text).toBe('edited B');
    store.cancelMessageEdit('m1');
    expect(store.messageEdit).toBeNull();
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.draftText).toBe('main composer draft');
    expect(session.revertSession).not.toHaveBeenCalled();
    expect(custody).not.toHaveBeenCalled();
  });

  it('发送编辑先原地回退再发送修改内容,保留原附件和主输入框草稿', async () => {
    const { store, session, turns } = await setup();
    Object.assign(turns[1]!.items[0]!, { attachments: [{ id: 'image-1', name: 'photo.png', mimeType: 'image/png' }], files: [{ itemId: 'pdf', version: 1, name: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 3 }] });
    store.setDraftText('main composer draft');
    store.beginMessageEdit('m1');
    store.changeMessageEdit('m1', 'edited B');
    await store.sendMessageEdit('m1');
    expect(session.revertSession).toHaveBeenCalledExactlyOnceWith('native-1', false);
    expect(custody).toHaveBeenCalledTimes(1);
    expect(custody.mock.calls[0]![0]).toBe(store);
    expect(custody.mock.calls[0]!.slice(1)).toEqual(['edited B',
      [{ ref: { type: 'attachment', id: 'image-1', name: 'photo.png', mimeType: 'image/png' } }],
      [{ itemId: 'pdf', version: 1, name: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 3 }]]);
    expect(session.revertSession.mock.invocationCallOrder[0]).toBeLessThan(custody.mock.invocationCallOrder[0]!);
    expect(committedIds(store)).toEqual(['s0']);
    expect(store.messageEdit).toBeNull();
    expect(store.draftText).toBe('main composer draft');
  });

  it('原生回退拒绝后保留编辑内容和当前对话,可重新点发送', async () => {
    const { store, session } = await setup();
    store.beginMessageEdit('m1'); store.changeMessageEdit('m1', 'edited B');
    session.revertSession.mockRejectedValueOnce(new Error('native refusal'));
    await store.sendMessageEdit('m1');
    expect(store.messageEdit?.text).toBe('edited B');
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(custody).not.toHaveBeenCalled();
    await store.sendMessageEdit('m1');
    expect(custody).toHaveBeenCalledTimes(1);
    expect(custody.mock.calls[0]!.slice(1)).toEqual(['edited B', [], []]);
  });

  it('发送时重新检查忙态与空文本,双击发送只回退一次', async () => {
    const { store, session } = await setup();
    store.beginMessageEdit('m1'); store.changeMessageEdit('m1', ' ');
    await store.sendMessageEdit('m1');
    expect(session.revertSession).not.toHaveBeenCalled();
    store.changeMessageEdit('m1', 'edited B');
    session.sessionState.current = () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: true });
    await store.sendMessageEdit('m1');
    expect(session.revertSession).not.toHaveBeenCalled();
    session.sessionState.current = () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: false });
    const first = store.sendMessageEdit('m1');
    await store.sendMessageEdit('m1');
    await first;
    expect(session.revertSession).toHaveBeenCalledTimes(1);
    expect(custody).toHaveBeenCalledTimes(1);
  });
});

describe('@@@history-change-cursor:侧边聊天每提交一轮只取改动游标之后的那几轮', () => {
  /** A side chat attached after `count` turns, whose window starts at the next one. */
  function opened(count: number) {
    const { store, internals } = sideChat();
    const runtime = fakeRuntime(count);
    internals.session = runtime.session;
    internals._runtimeWindowStartSeq = count;
    internals._runtimeCursor = { epoch: 'runtime', seq: count };
    internals._runtimeCount = count;
    return { store, internals, runtime };
  }

  it('新提交的一轮:问一次(带游标),只并进这一轮;❌ 一页页重取', async () => {
    const { store, internals, runtime } = opened(250);
    runtime.append(turn('r250', 250));
    await internals._refreshHistory();
    expect(runtime.calls).toEqual([{ before: undefined, changedSince: { epoch: 'runtime', seq: 250 } }]);
    expect(committedIds(store)).toEqual(['r250']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 251 });
  });

  it('窗口里的一轮被改了(迟到的尾巴):换掉手里那一份,❌ 再加一份', async () => {
    const { store, internals, runtime } = opened(5);
    runtime.append(turn('r5', 5));
    await internals._refreshHistory();
    runtime.revise(5, { ...turn('r5', 5), endedAt: 1 } as TranscriptTurn);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['r5']);
    expect(internals._runtimeTurns[0]).toMatchObject({ id: 'r5', endedAt: 1 });
  });

  it('回合数变少(回退 / 分叉):手里多出来的那几轮不再画', async () => {
    const { store, internals, runtime } = opened(5);
    runtime.append(turn('r5', 5));
    runtime.append(turn('r6', 6));
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['r5', 'r6']);
    runtime.committed.splice(6, 1);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['r5']);
  });

  it('keeps the newer history when concurrent delta replies arrive out of order', async () => {
    const { store, internals, runtime } = opened(1);
    runtime.append(turn('r1', 1));
    const olderReply = await runtime.session.getHistory(undefined, 100, internals._runtimeCursor!);
    let release!: (value: typeof olderReply) => void;
    const getHistory = runtime.session.getHistory;
    let calls = 0;
    runtime.session.getHistory = (...args) => ++calls === 1
      ? new Promise((resolve) => { release = resolve; }) : getHistory(...args);
    const first = internals._refreshHistory();
    runtime.append(turn('r2', 2));
    await internals._refreshHistory();
    release(olderReply);
    await first;
    expect(committedIds(store)).toEqual(['r1', 'r2']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 3 });
    store.dispose();
  });
});

describe('#2493 a reset change cursor does not take the live session away', () => {
  /** A live side chat with five runtime turns. */
  function live() {
    const { store, internals } = sideChat();
    const runtime = fakeRuntime(5);
    runtime.session.config.push({
      modeOptions: { selected: 'full-access', available: [{ id: 'full-access', name: 'Full access', description: null }] },
    });
    internals.session = runtime.session;
    internals._runtimeCursor = { epoch: 'runtime', seq: 5 };
    internals._runtimeCount = 5;
    return { store, internals, runtime };
  }

  function runtimeHistory() {
    const { store, internals, runtime } = live();
    const state = internals as Internals & {
      _bootstrapped: boolean; _runtimeBackgroundTaskIds: string[]; _runtimeLiveSubagentIds: string[];
    };
    state._bootstrapped = true;
    state._runtimeBackgroundTaskIds = ['background-live'];
    state._runtimeLiveSubagentIds = ['subagent-live'];
    // A side chat draws its own turns (startedAt), not the inherited replay context.
    for (let i = 0; i < runtime.committed.length; i++) runtime.committed[i] = { ...runtime.committed[i]!, startedAt: 1000 + i };
    runtime.committed[1] = { ...runtime.committed[1]!, items: [{
      kind: 'execute-tool-call', id: 'background-item', seq: 0, toolCallId: 'background-call',
      title: 'sleep 600', status: 'done', backgroundTaskId: 'background-live',
    }] } as TranscriptTurn;
    internals._runtimeWindowStartSeq = 3;
    internals._runtimeTurns = runtime.committed.slice(3);
    internals._olderHistoryTurns = runtime.committed.slice(1, 3);
    internals._olderCursor = 1;
    store.chatState.transcript.history.seed(runtime.committed.slice(1));
    const rows = () => collectBackgroundCommandRoster(
      store.chatState.transcript.state.committedTurns, null, 'Command', store.runningBackgroundTaskIds);
    // Model the host's same-epoch overflow reply and clipped full pages. Transport byte trimming has its own runtime tests.
    runtime.append({ ...turn('r5', 5), startedAt: 1005, items: Array.from({ length: 100 }, (_, seq) => ({
      kind: 'message', id: `large-${seq}`, seq, role: 'assistant', text: 'trace-'.repeat(700),
    })) } as TranscriptTurn);
    runtime.append({ ...turn('r6', 6), startedAt: 1006 } as TranscriptTurn);
    runtime.clipPages(1);
    runtime.oversize();
    const reattach = vi.spyOn(store, 'reattachAfterHostReload');
    const bootstrap = vi.spyOn(internals, '_runBootstrap').mockResolvedValue(undefined);
    return { store, internals, runtime, rows, reattach, bootstrap };
  }

  it('#2493 #3167 keeps live controls and the displayed history after a same-epoch overflow', async () => {
      const { store, internals, runtime, rows, reattach, bootstrap } = runtimeHistory();
      expect(rows()).toHaveLength(1);
      expect(store.permissionModeOptions).not.toBeNull();
      const delta = await runtime.session.getHistory(undefined, 100, internals._runtimeCursor!);
      expect(delta.success && delta.data.reset).toBe(true);
      await internals._refreshHistory();
      expect(reattach).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(internals.session).toBe(runtime.session);
      expect(store.permissionModeOptions).not.toBeNull();
      expect(store.runningBackgroundTaskIds).toEqual(['background-live']);
      expect(store.liveSubagentIds).toEqual(['subagent-live']);
      expect(rows()).toHaveLength(1);
      expect(committedIds(store)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
      expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 7 });
      expect((await internals.loadOlderHistory()).map(next => next.id)).toEqual(['r0']);
      store.dispose();
    });

  it('#3167 discards a history page requested before the in-place rebuild', async () => {
    const { store, internals, runtime } = runtimeHistory();
    const getHistory = runtime.session.getHistory;
    const oldPage = await getHistory(1, 100);
    let release!: (value: typeof oldPage) => void;
    let blocked = false;
    runtime.session.getHistory = (...args) => args[0] === 1 && !blocked
      ? (blocked = true, new Promise(resolve => { release = resolve; })) : getHistory(...args);
    const prior = internals.loadOlderHistory();
    await internals._refreshHistory();
    release(oldPage);
    expect(await prior).toEqual([]);
    expect(committedIds(store)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 7 });
    store.dispose();
  });

  it('#3167 includes a page the person loaded while the runtime window was being rebuilt', async () => {
    const { store, internals, runtime, rows } = runtimeHistory();
    const getHistory = runtime.session.getHistory;
    const held = await getHistory(6, 100);
    let release!: (value: typeof held) => void;
    let blocked = false;
    runtime.session.getHistory = (...args) => args[0] === 6 && !blocked
      ? (blocked = true, new Promise(resolve => { release = resolve; })) : getHistory(...args);
    const refresh = internals._refreshHistory();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(committedIds(store)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(store.permissionModeOptions).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect((await internals.loadOlderHistory()).map(next => next.id)).toEqual(['r0']);
    release(held);
    await refresh;
    expect(committedIds(store)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(internals._olderCursor).toBeNull();
    store.dispose();
  });

  it('#3167 ignores an older rebuild response after a newer reconciliation won', async () => {
    const { store, internals, runtime } = runtimeHistory();
    const getHistory = runtime.session.getHistory;
    const oldHead = await getHistory(undefined, 100);
    let release!: (value: typeof oldHead) => void;
    let blocked = false;
    runtime.session.getHistory = (...args) => args[0] === undefined && args[2] === undefined && !blocked
      ? (blocked = true, new Promise(resolve => { release = resolve; })) : getHistory(...args);
    const older = internals._refreshHistory();
    await vi.waitFor(() => expect(release).toBeDefined());
    runtime.append({ ...turn('r7', 7), startedAt: 1007 } as TranscriptTurn);
    await internals._refreshHistory();
    release(oldHead);
    await older;
    expect(internals.session).toBe(runtime.session);
    expect(committedIds(store)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 8 });
    store.dispose();
  });

  it('#3167 re-attaches if the runtime changes epoch while the fresh history head is read', async () => {
    const { store, internals, runtime, reattach } = runtimeHistory();
    const getHistory = runtime.session.getHistory;
    runtime.session.getHistory = (...args) => {
      if (args[2] === undefined && args[0] === undefined) runtime.restart();
      return getHistory(...args);
    };
    await internals._refreshHistory();
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(internals.session).toBeNull();
    store.dispose();
  });

  it('#3167 reports a failed history read without clearing live controls or retrying it', async () => {
    const { store, internals, runtime, rows, reattach } = runtimeHistory();
    const getHistory = runtime.session.getHistory;
    let reads = 0;
    runtime.session.getHistory = (...args) => {
      if (args[2] === undefined) { reads++; return Promise.reject(new Error('history unavailable')); }
      return getHistory(...args);
    };
    await internals._refreshHistory();
    expect(reads).toBe(1);
    expect(reattach).not.toHaveBeenCalled();
    expect(internals.session).toBe(runtime.session);
    expect(store.permissionModeOptions).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect(committedIds(store)).toEqual(['r1', 'r2', 'r3', 'r4']);
    store.dispose();
  });

  it('#3167 reads only the newest page when no runtime history window was displayed', async () => {
    const { store, internals, runtime } = runtimeHistory();
    internals._runtimeTurns = [];
    internals._olderHistoryTurns = [];
    store.chatState.transcript.history.seed([]);
    await internals._refreshHistory();
    expect(runtime.calls).toHaveLength(2);
    expect(committedIds(store)).toEqual(['r6']);
    expect(internals._olderCursor).toBe(6);
    expect(internals.session).toBe(runtime.session);
    store.dispose();
  });

  it('a restarted runtime (another epoch) still re-attaches', async () => {
    const { store, internals, runtime } = live();
    runtime.restart();
    const reattach = vi.spyOn(store, 'reattachAfterHostReload').mockImplementation(() => {});

    await internals._refreshHistory();

    expect(reattach).toHaveBeenCalledTimes(1);
    store.dispose();
  });

});

describe('reopening a host pipe resumes the retained transcript', () => {
  function retained() {
    const { store, internals } = sideChat();
    const runtime = fakeRuntime(5);
    internals._runtimeCursor = { epoch: 'runtime', seq: 5 };
    internals._runtimeCount = 5;
    internals._runtimeWindowStartSeq = 3;
    internals._runtimeTurns = runtime.committed.slice(3);
    internals._olderHistoryTurns = runtime.committed.slice(0, 3);
    internals._olderCursor = 0;
    resumeSession = runtime.session;
    return { store, internals, runtime };
  }

  it('requests only the gap and preserves previously loaded older pages', async () => {
    const { store, internals, runtime } = retained();
    runtime.append(turn('r5', 5));
    await internals._runBootstrap({ attachOnly: true });
    expect(runtime.calls).toEqual([{ before: undefined, changedSince: { epoch: 'runtime', seq: 5 } }]);
    expect(committedIds(store)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    store.dispose();
  });

  it('a host epoch change clears the stale cursor and reloads one first page', async () => {
    const { store, internals, runtime } = retained();
    runtime.restart();
    await internals._runBootstrap({ attachOnly: true });
    expect(runtime.calls).toEqual([
      { before: undefined, changedSince: { epoch: 'runtime', seq: 5 } },
      { before: undefined, changedSince: undefined },
    ]);
    expect(committedIds(store)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._runtimeCursor?.epoch).toBe('restarted-runtime');
    store.dispose();
  });
});

describe('#5381 评审 #4:重挂会话时清掉上一次的历史状态', () => {
  it('清回初值,且代数 +1', () => {
    const { internals } = sideChat();
    internals._olderHistoryTurns = [turn('o0', 0)];
    internals._olderCursor = 3;
    internals._runtimeTurns = [turn('r9', 9)];
    internals._runtimeWindowStartSeq = 9;
    const before = internals._historyGeneration;

    internals._resetHistoryState();

    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._olderCursor).toBeUndefined();
    expect(internals._runtimeTurns).toEqual([]);
    expect(internals._runtimeWindowStartSeq).toBe(0);
    expect(internals._historyGeneration).toBe(before + 1);
  });

  it('重挂之前发出去的翻页,回来时对不上号就丢弃,❌ 不写回旧页', async () => {
    const { internals } = sideChat();
    let resolvePage!: (value: unknown) => void;
    internals.session = {
      getHistory: () => new Promise((resolve) => { resolvePage = resolve; }),
    };
    internals._olderCursor = 10;

    const pending = internals.loadOlderHistory();
    internals._resetHistoryState();
    resolvePage({ success: true, data: { turns: [turn('r8', 8), turn('r9', 9)], nextCursor: null } });
    await pending;

    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._olderCursor).toBeUndefined();
  });
});
