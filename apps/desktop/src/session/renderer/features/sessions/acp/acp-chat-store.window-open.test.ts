// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { installAcpChatStoreHost, replica } from './acp-chat-store.test-host';

// Exercise the real transcript and live binding, without constructing a layout or syntax highlighter.
vi.mock('@session-chat/core/caches', () => ({ createParseCaches: () => ({ clearAll() {} }) }));
vi.mock('@renderer/lib/chat/shared-chat-context', () => ({ getSharedChatContext: () => ({}) }));
vi.mock('@gugu/session-chat-ui', async () => ({
  ...await import('@session-chat/state/chat-state'),
  ...await import('@session-chat/state/pending-prompt'),
  ...await import('@session-chat/lib/background-command-roster'),
  turnDiscardedId: (await import('@session-chat/state/flatten')).turnDiscardedId,
}));

const prepared = { workerEpoch: 'worker', storeEpoch: 'store', sequence: 7 };
const LEASE = '00000000-0000-4000-8000-000000000001';
const GAP_POSITION = { projectionId: 'source/projection', rowId: 'gap-row', storedSeq: 1, referenceId: 'gap-ref' };
const handle = (name: string) => `${name}-${'h'.repeat(40)}`;
const gapCommit = (kind: 'insert' | 'needs_location') => ({ hasMore: false, next: { ...prepared, sequence: 8 }, entries: [kind === 'insert'
  ? { kind, ...GAP_POSITION, firstCommitCursor: { ...prepared, sequence: 8 }, latestRevisionCursor: { ...prepared, sequence: 8 } }
  : { kind, referenceId: 'gap-ref', rowId: 'gap-row', storedSeq: 1, firstCommitCursor: { ...prepared, sequence: 8 }, latestRevisionCursor: { ...prepared, sequence: 8 } }] });
const f = vi.hoisted(() => ({
  records: new Map<string, Partial<Session>>(), listeners: new Map<string, (event: unknown) => void>(),
  calls: [] as string[], phase: 'stopped', source: 'window', prepare: null as Promise<unknown> | null,
  setupFailure: null as { code: string; message: string } | null,
  watchChanged: () => {}, live: null as unknown, attach: null as Promise<unknown> | null,
  liveReads: [] as unknown[], commitPages: [] as unknown[], projection: [] as string[],
}));
vi.mock('../stores/session-registry', () => ({ sessionRegistry: { get: (id: string) =>
  f.records.has(id) ? { sessions: new Map([[id, { data: f.records.get(id) }]]) } : undefined } }));
vi.mock('@renderer/lib/acp/running-sessions', () => ({ watchRunningSession: async (_id: string, callbacks: { onChange(): void }) => {
  f.watchChanged = callbacks.onChange;
  return { phase: () => f.phase, dispose: () => {} };
} }));
vi.mock('@renderer/lib/acp/acp-session-attachment', () => ({ attachAcpSessionWhenReady: async () => { await f.attach; return f.live; } }));
vi.mock('@renderer/lib/acp/runtime-client', () => ({ getAcpRuntimeClient: async () => ({ getStoredQueue: async () => [] }) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
vi.mock('./queue-native-input', () => ({ sendThroughCustody: async () => {}, canQueueNativeInput: () => false }));
vi.mock('../stores/session-life-views', () => ({
  sessionLifeView: () => null, readSessionLife: async () => ({ kind: 'ready' }), startSessionLife: async () => {},
  stopSessionLife: async () => {}, discardSessionLifeRow: async () => {}, endSessionLife: async () => {},
  forkSessionLife: async () => {}, retryUnknownSessionInput: async () => {},
}));

installAcpChatStoreHost(async (channel: string, ...args: unknown[]) => {
  f.calls.push(channel);
  if (channel === 'sessionTimeline.sessionWindowPrepare') return f.prepare ?? { ok: true, value: f.source === 'window' ? { source: 'window', liveCursor: prepared } : { source: 'legacy' } };
  if (channel === 'sessionTimeline.sessionWindowLiveRead') {
    // The host's commit queue after the Prepare cursor; an empty queue keeps the unique read waiting.
    f.liveReads.push(args[0]);
    const page = f.commitPages.shift();
    return page ? { ok: true, value: page } : new Promise(() => {});
  }
  if (channel === 'sessionTimeline.sessionWindowProjectionRead') {
    const input = args[0] as { kind: string; cursor?: string };
    f.projection.push(input.kind);
    if (input.kind === 'open') return { ok: true, value: { lease: LEASE, position: GAP_POSITION, count: 1, next: handle('page-0'),
      root: { target: 'turn', values: { id: 'gap-turn', seq: 1, referenceId: 'gap-ref', initiator: 'user' }, fields: [] } } };
    if (input.kind === 'page') return { ok: true, value: { lease: LEASE, position: GAP_POSITION, ordinal: 0, entityId: 'gap-reply-entity',
      parentEntityId: null, hasChildren: false, next: null, bodies: [{ field: 'text', handle: handle('text') }],
      header: { target: 'item', values: { id: 'gap-reply', seq: 0, kind: 'message', role: 'assistant' }, fields: [] } } };
    return { ok: true, value: undefined };
  }
  if (channel === 'sessionTimeline.sessionWindowProjectionBodyRead')
    return { ok: true, value: { kind: 'body', offset: 0, text: 'Reply from another sender', next: null } };
  if (channel === 'sessionTimeline.sessionWindowLiveAck') return { ok: true, value: undefined };
  if (channel === 'sessionTimeline.sessionWindowSubscribe') {
    if (f.setupFailure) return { ok: false, error: f.setupFailure };
    const { subscriptionId } = args[0] as { subscriptionId: string };
    f.listeners.get(`session-timeline:push.${subscriptionId}`)!({ subscriptionId, result: { ok: false, reset: 'epoch_changed', snapshot: {
      cursor: { epoch: 'source', seq: 0 }, turns: [], settlements: [], hasOlder: false,
      sourceLineage: 'file', snapshotRevision: 'revision',
      sourceFragments: [{ key: 'old-record', ownership: 'unresolved', sourceRange: { start: 10, end: 90 }, text: 'Persisted bounded history' }],
    } } });
    return { ok: true, value: null };
  }
  if (channel === 'sessions.getStoredHistory' || channel === 'sessions.syncStoredHistoryFromRecord') {
    if (f.source === 'window') throw new Error(`Forbidden legacy read: ${channel}`);
    return channel === 'sessions.getStoredHistory' ? { turns: [], originTurnIds: [], nextCursor: null } : { inserted: 0 };
  }
  return [];
}, (channel, callback) => {
  f.listeners.set(channel, callback);
  return () => f.listeners.delete(channel);
}, { openingHistory: 'host' });
const { AcpChatStore } = await import('./acp-chat-store');
const stores: InstanceType<typeof AcpChatStore>[] = [];
function makeStore(providerId: Session['providerId'] = 'claude') {
  const store = new AcpChatStore(`window-${stores.length}`, 'project');
  f.records.set(store.sessionId, { providerId, providerSessionId: 'native' });
  stores.push(store);
  return store;
}
function live() {
  return {
    agents: replica([]), config: replica({}), usage: replica(null), plan: replica(null), terminals: replica([]), draft: replica(null),
    activeTurn: replica<TranscriptTurn | null>(null),
    sessionState: replica({ lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], queuedPrompts: [], isGenerating: false, backgroundAgentCount: 0 }),
    onDraftSyncReady: () => () => {}, canSyncDraft: () => false, dispose: () => {},
    getHistory: vi.fn(async () => {
      if (f.source === 'window') throw new Error('Forbidden numeric history read');
      return { success: true, data: { turns: [], nextCursor: null, cursor: { epoch: 'runtime', seq: 0 }, count: 0 } };
    }),
  };
}
const readable = async (store: InstanceType<typeof AcpChatStore>) => vi.waitFor(() => expect(store.sourceWindow?.sourceFragments?.[0]?.text).toBe('Persisted bounded history'));
beforeEach(() => { f.calls.length = 0; f.phase = 'stopped'; f.source = 'window'; f.prepare = null; f.setupFailure = null; f.live = live(); f.attach = null; f.liveReads.length = 0; f.commitPages.length = 0; f.projection.length = 0; });
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); f.records.clear(); vi.restoreAllMocks(); });

it('chooses the source before stored/backfill I/O and displays bounded body without a canonical turn', async () => {
  const store = makeStore();
  let resolve!: (value: unknown) => void;
  f.prepare = new Promise(yes => { resolve = yes; });
  store.bootstrap();
  await vi.waitFor(() => expect(f.calls).toContain('sessionTimeline.sessionWindowPrepare'));
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
  resolve({ ok: true, value: { source: 'window', liveCursor: prepared } });
  await readable(store);
  await vi.waitFor(() => expect(store.historyLoading).toBe(false));
  expect(store.chatState.transcript.state.committedTurns).toEqual([]);
  expect(store.isEmpty).toBe(false);
  expect(f.calls.filter(name => name === 'sessionTimeline.sessionWindowSubscribe')).toHaveLength(1);
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
});

it('selects bounded history before a missing-provider bootstrap and retains its missing-provider notice', async () => {
  const store = makeStore();
  f.records.get(store.sessionId)!.providerSessionState = 'missing';
  store.bootstrap(); await readable(store);
  await vi.waitFor(() => expect(store.loadError).toMatchObject({ kind: 'provider_session_missing' }));
  expect(f.calls).toContain('sessionTimeline.sessionWindowPrepare');
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
});

it.each(['claude', 'codex'] as const)('leaves ready/busy-at-open %s on the explicitly selected legacy path', async provider => {
  f.source = 'legacy'; f.phase = 'running';
  const store = makeStore(provider); store.bootstrap();
  await vi.waitFor(() => expect(store.session).not.toBeNull());
  expect(f.calls).toContain('sessions.getStoredHistory');
  expect((f.live as ReturnType<typeof live>).getHistory).toHaveBeenCalled();
  expect(f.calls).not.toContain('sessionTimeline.sessionWindowSubscribe');
  expect(store.sourceWindow).toBeUndefined();
});

it.each(['opencode', 'hermes', 'copilot', 'qwen', 'pi', 'codebuddy'] as const)('keeps unsupported %s on its existing route before preparation', async provider => {
  f.source = 'legacy'; const store = makeStore(provider); store.bootstrap();
  await vi.waitFor(() => expect(f.calls).toContain('sessions.getStoredHistory'));
  expect(f.calls).not.toContain('sessionTimeline.sessionWindowPrepare');
  expect(f.calls).not.toContain('sessionTimeline.sessionWindowSubscribe');
});

it('releases a late preparation after the real store has been disposed without starting a reader', async () => {
  let resolve!: (value: unknown) => void;
  f.prepare = new Promise(yes => { resolve = yes; });
  const store = makeStore(); store.bootstrap();
  await vi.waitFor(() => expect(f.calls).toContain('sessionTimeline.sessionWindowPrepare'));
  store.dispose();
  resolve({ ok: true, value: { source: 'window', liveCursor: prepared } });
  await vi.waitFor(() => expect(f.calls.filter(name => name === 'sessionTimeline.sessionUnsubscribe').length).toBeGreaterThanOrEqual(2));
  expect(f.calls).not.toContain('sessionTimeline.sessionWindowSubscribe');
  expect(f.calls).not.toContain('sessions.getStoredHistory');
});

it('fails a changed/ABA opening without running an old reader', async () => {
  f.prepare = Promise.resolve({ ok: false, error: { code: 'scope_changed', message: 'The runtime changed' } });
  const store = makeStore(); store.bootstrap();
  await vi.waitFor(() => expect(store.loadError).toMatchObject({ kind: 'history_unavailable', message: 'The runtime changed' }));
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessionTimeline.sessionWindowSubscribe');
});

it('keeps an accepted window choice on scope_changed instead of falling back to legacy at Subscribe', async () => {
  f.setupFailure = { code: 'scope_changed', message: 'The stopped proof changed before publication' };
  const store = makeStore(); store.bootstrap();
  await vi.waitFor(() => expect(store.loadError).toMatchObject({ kind: 'history_unavailable', message: f.setupFailure!.message }));
  expect(store.historyLoading).toBe(false);
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
});

it('retains painted history on the real status channel without restarting or changing the reader', async () => {
  const store = makeStore(); store.bootstrap(); await readable(store);
  const topic = [...f.listeners.keys()].find(key => key.startsWith('session-window:status.'))!;
  f.listeners.get(topic)!({ conversationId: store.sessionId, subscriptionId: topic.slice('session-window:status.'.length),
    state: 'failed', error: { code: 'record_unreadable', message: 'The pinned source changed' } });
  expect(store.loadError).toMatchObject({ kind: 'history_unavailable', message: 'The pinned source changed' });
  expect(store.historyLoading).toBe(false);
  expect(store.sourceWindow?.sourceFragments?.[0]?.text).toBe('Persisted bounded history');
  expect(f.calls.filter(name => name === 'sessionTimeline.sessionWindowSubscribe')).toHaveLength(1);
  expect(f.calls).not.toContain('sessions.getStoredHistory');
});

it('keeps a stopped opening pinned while a newly attached live turn commits exactly once without numeric replay', async () => {
  const store = makeStore(); store.bootstrap(); await readable(store);
  f.phase = 'running'; f.watchChanged();
  await vi.waitFor(() => expect(store.session).not.toBeNull());
  const session = f.live as ReturnType<typeof live>;
  const turn: TranscriptTurn = { id: 'new-turn', seq: 0, initiator: 'user', items: [
    { kind: 'message', id: 'new-reply', seq: 0, role: 'assistant', text: 'New live reply' },
  ] };
  session.activeTurn.push(turn);
  const next = { ...turn, id: 'queued-turn', seq: 1, items: [{ ...turn.items[0]!, id: 'queued-reply' }] };
  session.activeTurn.push(next);
  session.activeTurn.push(null);
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map(row => row.id)).toEqual(['new-turn', 'queued-turn']));
  expect(session.getHistory).not.toHaveBeenCalled();
  expect(store.sourceWindow?.sourceFragments?.map(row => row.key)).toEqual(['old-record']);
  await store.syncOwnerNotifications(500); await store.loadOlderHistory();
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
});

it('reopens a released stopped transcript through a new preparation without reading the stored cache', async () => {
  const store = makeStore(); store.bootstrap(); await readable(store);
  await vi.waitFor(() => expect(store.historyLoading).toBe(false));
  store.releaseTranscript(); store.bootstrap(); await readable(store);
  expect(f.calls.filter(name => name === 'sessionTimeline.sessionWindowPrepare')).toHaveLength(2);
  expect(f.calls).not.toContain('sessions.getStoredHistory');
  expect(f.calls).not.toContain('sessions.syncStoredHistoryFromRecord');
});

// #2165 review blocker (6745567c): after the opening window is readable and before the live listener
// attaches, another sender can start and finish a whole turn. The pinned window excludes it and the
// attached activeTurn is already null, so only the host's committed queue after the Prepare cursor
// proves it happened. Materializing that reference into a turn needs the canonical projection read
// (#2279); until it is wired this case stays red. No timestamp, size or text dedupe may satisfy it.
it('shows a turn completed between the opening window and live attachment from the committed queue', async () => {
  let attach!: () => void;
  f.attach = new Promise<void>(yes => { attach = yes; });
  f.commitPages.push(gapCommit('insert'));
  const store = makeStore(); store.bootstrap(); await readable(store);
  f.phase = 'running'; f.watchChanged();
  const session = f.live as ReturnType<typeof live>;
  session.activeTurn.push({ id: 'gap-turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'gap-reply', seq: 0, role: 'assistant', text: 'Reply from another sender' },
  ] });
  session.activeTurn.push(null);
  attach();
  await vi.waitFor(() => expect(store.session).not.toBeNull());
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map(row => row.id)).toContain('gap-turn'));
  expect(f.liveReads[0]).toMatchObject({ conversationId: store.sessionId, after: prepared });
  const turn = store.chatState.transcript.state.committedTurns.find(row => row.id === 'gap-turn')!;
  expect(turn.items).toMatchObject([{ id: 'gap-reply', kind: 'message', role: 'assistant', text: 'Reply from another sender' }]);
  expect(store.chatState.transcript.state.committedTurns.filter(row => row.id === 'gap-turn')).toHaveLength(1);
  await vi.waitFor(() => expect(f.calls).toContain('sessionTimeline.sessionWindowLiveAck'));
  expect(f.projection).toEqual(['open', 'page', 'release']);
  expect(session.getHistory).not.toHaveBeenCalled();
  expect(f.calls).not.toContain('sessions.getStoredHistory');
});

it('keeps an over-large committed turn as unlocated without failing or dropping later turns', async () => {
  f.commitPages.push(gapCommit('needs_location'));
  const store = makeStore(); store.bootstrap(); await readable(store);
  await vi.waitFor(() => expect(store.windowUnlocatedTurns).toEqual([{ referenceId: 'gap-ref', storedSeq: 1 }]));
  expect(store.loadError).toBeNull();
  expect(f.projection).toEqual([]);
  await vi.waitFor(() => expect(f.calls).toContain('sessionTimeline.sessionWindowLiveAck'));
  expect(f.liveReads).toHaveLength(2);
});
