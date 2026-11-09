// @vitest-environment jsdom
/**
 * #6574 排队提示的「立即发送」按这家能不能插话分两路:能插 ⇒ 交给运行时插进在飞的那一轮
 * (一次原子调用,❌ 取消、❌ 渲染层自己拼「删 + 发」);插不了 ⇒ 挪到队首,在跑就取消。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { SessionInputOutbox, openSessionInputStorage } from '@/lib/sessionInputOutbox';
import { SessionInputAdmissionError } from '@gugu/core/shared/sessionInputAdmission';
import { state as inputState, changed as inputsChanged, EMPTY } from '@/lib/sessionInputOutboxBridge';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { installAcpChatStoreHost } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
const toasts = vi.hoisted(() => [] as Array<{ title?: string }>);
const visible = vi.hoisted(() => new Map<string | number, string>());
vi.mock('sonner', () => {
  let sequence = 0;
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? ++sequence; visible.set(id, title); return id; };
  return { toast: Object.assign(show, { error: show, info: show, warning: show, success: show, dismiss: (id: string | number) => visible.delete(id) }) };
});
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }));
vi.mock('@/lib/notices', async original => {
  const notices = await original<typeof import('@/lib/notices')>();
  return { ...notices, notify: (notice: import('@/lib/notices').Notice) => { toasts.push(notice); return notices.notify(notice); } };
});
vi.mock('@renderer/lib/hooks/use-toast', async () => ({ toast: (await import('@/lib/notices')).notify }));

installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');

const ok = { success: true as const, data: undefined };

let seq = 0;
function makeStore(
  steerResult: { success: boolean; error?: unknown } = ok,
  lifecycle: 'ready' | 'working' = 'working',
) {
  seq += 1;
  const store = new AcpChatStore(`conv-6574-${seq}`, 'proj-1');
  const session = {
    sessionState: {
      current: () => ({
        lifecycle,
        pendingPermissions: [],
        activeTurnId: lifecycle === 'working' ? 'turn-1' : null,
        queuedPrompts: [
          { id: 'q-1', text: 'first queued', origin: 'manual', createdAt: 1, updatedAt: 1 },
          { id: 'q-2', text: 'second queued', origin: 'manual', createdAt: 2, updatedAt: 2 },
        ],
      }),
    },
    steerQueuedPrompt: vi.fn(async () => steerResult),
    changeQueuePromptOrder: vi.fn(async () => ok),
    cancelTurn: vi.fn(async () => ok),
  };
  store.session = session as never;
  return { store, session };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  toasts.length = 0; visible.clear();
});

describe('#6574 立即发送按插话能力分两路', () => {
  it('能插话:一次交给运行时插进当前回合,❌ 重排、❌ 取消', async () => {
    const { store, session } = makeStore();
    expect(store.affordances.isWorking).toBe(true);
    store.sendQueuedPromptNow('q-2', { steers: true });
    await settle();
    expect(session.steerQueuedPrompt).toHaveBeenCalledWith('q-2');
    expect(session.changeQueuePromptOrder).not.toHaveBeenCalled();
    expect(session.cancelTurn).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('插不了:照旧挪到队首并取消在跑的回合,❌ 走插话', async () => {
    const { store, session } = makeStore();
    expect(store.affordances.isWorking).toBe(true);
    store.sendQueuedPromptNow('q-2', { steers: false });
    await settle();
    expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['q-2', 'q-1']);
    expect(session.cancelTurn).toHaveBeenCalledOnce();
    expect(session.steerQueuedPrompt).not.toHaveBeenCalled();
  });

  it('插不了且没在跑:只挪到队首', async () => {
    const { store, session } = makeStore(ok, 'ready');
    store.sendQueuedPromptNow('q-2', { steers: false });
    await settle();
    expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['q-2', 'q-1']);
    expect(session.cancelTurn).not.toHaveBeenCalled();
  });

  it('插话失败要说出来', async () => {
    const { store } = makeStore({ success: false, error: new Error('adapter refused') });
    store.sendQueuedPromptNow('q-2', { steers: true });
    await settle();
    expect(toasts.map((entry) => entry.title)).toEqual([translateSessionMessage('acpFailure.sendMessage')]);
  });

  it('已经不在队里的条目什么都不做', async () => {
    const { store, session } = makeStore();
    store.sendQueuedPromptNow('gone', { steers: true });
    await settle();
    expect(session.steerQueuedPrompt).not.toHaveBeenCalled();
  });
});

afterEach(() => { vi.unstubAllGlobals(); Object.assign(inputState(), { accountId: null, queue: null, rows: EMPTY, valid: () => false }); inputsChanged(); });

it('keeps one notice per native queued message across failed retries and retires only its successful retry', async () => {
  const { store, session } = makeStore();
  session.steerQueuedPrompt.mockRejectedValue(new Error('refused'));
  store.sendQueuedPromptNow('q-1', { steers: true });
  store.sendQueuedPromptNow('q-2', { steers: true });
  await settle();
  expect(visible.size).toBe(2);
  store.sendQueuedPromptNow('q-1', { steers: true });
  await settle();
  expect(visible.size).toBe(2);
  session.steerQueuedPrompt.mockResolvedValue(ok);
  store.sendQueuedPromptNow('q-1', { steers: true });
  await settle();
  expect(visible.size).toBe(1);
});

it('retries a rejected input through real sender storage, preserving another message failure', async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const { store } = makeStore();
  const storage = await openSessionInputStorage(new IDBFactory());
  let refuse = true;
  const queue = new SessionInputOutbox('owner', storage, async () => {
    if (refuse) throw new SessionInputAdmissionError('refused', 'rejected');
  }, () => true, rows => { if (rows) inputState().rows = rows; inputsChanged(); });
  Object.assign(inputState(), { accountId: 'owner', queue: Promise.resolve(queue), valid: () => true });
  const a = await queue.enqueue({ deviceId: null, sessionId: store.runtimeSessionId, text: 'same words' });
  const b = await queue.enqueue({ deviceId: null, sessionId: store.runtimeSessionId, text: 'same words' });
  await queue.flush(); await queue.flush();
  inputState().rows = await queue.list(); inputsChanged();
  const put = vi.spyOn(storage, 'put').mockRejectedValue(new Error('storage unavailable'));
  store.retryPendingInput(a.id); store.retryPendingInput(b.id);
  await vi.waitFor(() => expect(visible.size).toBe(2));
  store.retryPendingInput(a.id); await settle();
  expect(visible.size).toBe(2);
  put.mockRestore(); refuse = false;
  store.retryPendingInput(a.id);
  await vi.waitFor(() => expect(visible.size).toBe(1));
  expect((await queue.list()).map(input => input.id)).toEqual([b.id]);
});

it('keeps host-owned unknown retries message-owned even before they enter the local pending projection', async () => {
  const { store } = makeStore();
  let refuse = true;
  const retried: string[] = [];
  installAcpChatStoreHost(async (channel, ...args) => {
    if (channel === 'sessions.lifeView') return { sessionId: store.runtimeSessionId, kind: 'ready', version: 1,
      pending: { items: ['host-a', 'host-b'].map(messageId => ({ messageId, state: 'unknown', resendable: true })), count: 0 } };
    if (channel === 'sessions.lifeRetryUnknown') {
      expect(args[0]).toBe(store.runtimeSessionId); retried.push(args[1]);
      if (refuse) throw new Error('host retry refused');
    }
    return [];
  });
  await (await import('../stores/session-life-views')).readSessionLife(store.runtimeSessionId);
  expect(store.chatState.session.state.pendingMessages).toEqual([]);
  store.retryPendingInput('host-a'); store.retryPendingInput('host-b');
  await vi.waitFor(() => expect(visible.size).toBe(2));
  store.retryPendingInput('host-a'); await settle();
  expect(visible.size).toBe(2);
  refuse = false; store.retryPendingInput('host-a');
  await vi.waitFor(() => expect(visible.size).toBe(1));
  expect(retried).toEqual(['host-a', 'host-b', 'host-a', 'host-a']);
});

it('settles the host row notice through its real discard RPC rather than the sender rejected-input branch', async () => {
  const { store } = makeStore();
  const discard = vi.fn<() => Promise<void>>(async () => { throw new Error('host discard refused'); });
  installAcpChatStoreHost(async (channel, ...args) => {
    if (channel === 'sessions.lifeDiscard') { expect(args).toEqual([store.runtimeSessionId, 'host-row']); return discard(); }
    return [];
  });
  store.discardRejectedInput('host-row');
  await vi.waitFor(() => expect(visible.size).toBe(1));
  discard.mockResolvedValue(undefined); store.discardRejectedInput('host-row');
  await vi.waitFor(() => expect(visible.size).toBe(0));
  expect(discard).toHaveBeenCalledTimes(2);
});
