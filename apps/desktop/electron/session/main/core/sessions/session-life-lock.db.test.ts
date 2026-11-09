import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@gugu/session-shared/logger';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';
import type { NativeInputEvidence, NativeInputLookup } from '@gugu/core/local/agent/deliveryIdentity';
import type { LegAdapter } from './session-life-adapter';
import { SessionLife } from './session-life';
import { readNativeInputTail } from '@gugu/session-core/session-record';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, nativePath: '' }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
vi.mock('../session-timeline/service', () => ({
  readSessionRow: () => fixture.sqlite.prepare('SELECT provider, provider_session_id AS providerSessionId, runtime FROM sessions WHERE id = ?').get('s'),
  locateRow: (row: { providerSessionId: string }) => ({ supported: true, locator: { harness: 'codex', providerSessionId: row.providerSessionId, roots: [] } }),
}));
vi.mock('../acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: () => new Map([['s', { providerId: 'codex', transcriptPath: mocks.nativePath }]]) } }));
import { nativePendingInputLookup } from './session-pending-history';
import { lifeStore } from './session-pending';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let blocker: Database.Database;
beforeEach(async () => {
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/repo'); INSERT INTO sessions(id,project_id,title) VALUES ('s','p','S')");
  fixture.sqlite.pragma('busy_timeout=1');
  blocker = new Database(fixture.sqlite.name);
});
afterEach(() => { blocker.close(); fixture.close(); mocks.db = undefined; });

function lock() { blocker.exec("BEGIN IMMEDIATE; UPDATE projects SET name='locked' WHERE id='p'"); }
function rig(ownedBy = async () => true, nativeInputs?: NativeInputLookup) {
  let exit: Parameters<LegAdapter['onExit']>[1] | undefined;
  const run = vi.fn<(at: StageName) => void>();
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => ({ result: 'accepted', nativeReceiptId: 'native' }));
  const teardown = vi.fn<LegAdapter['teardown']>(async () => {});
  const failed = vi.fn();
  const store = { ...lifeStore, commit: vi.fn(lifeStore.commit) };
  const owner = new SessionLife({ logger: noopLogger, sessions: () => ['s'], store: () => store,
    adapter: () => ({ leg: 'acp', timing: 'next-tool-call',
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        run(at);
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing: 'next-tool-call' }) as StageOut[K];
      }, dispatch, teardown,
      onExit: (_have, cb) => { exit = cb; return () => {}; } }),
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy,
    ...(nativeInputs ? { nativeInputs: () => nativeInputs } : {}),
    markRead: async () => {}, reportFailure: async () => {}, publish: () => {}, removed: () => {}, failed, now: Date.now });
  return { owner, store, failed, run, dispatch, teardown, exit: () => exit!({ cause: { name: 'Exit', message: 'gone' }, code: 1, signal: null }),
    send: (id: string) => owner.enqueue({ sessionId: 's', messageId: id, text: id, kind: 'ordinary' }) };
}

it('keeps an accepted receipt through a same-process write transaction, then admits later events exactly once', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.dispatch.mockImplementationOnce(async () => { lock(); return { result: 'accepted', nativeReceiptId: 'first' }; });
  const first = r.send('first'); const second = r.send('second');
  await vi.waitFor(() => expect(r.failed).toHaveBeenCalledTimes(1));
  expect(lifeStore.row('s', first.seq).state).toBe('dispatching');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  let drained = false;
  const draining = r.owner.quiescent('s').then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(drained).toBe(false);
  blocker.exec('COMMIT');
  await draining;
  expect([first, second].map(row => lifeStore.row('s', row.seq).state)).toEqual(['accepted', 'accepted']);
  expect(r.dispatch.mock.calls.map(call => call[1].message.id)).toEqual(['first', 'second']);
  r.send('third'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(3);
  await r.owner.signOut();
});

it('retries a stage decision after one BUSY without rerunning the completed stage', async () => {
  const r = rig(); await r.owner.signIn('A');
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'run-stage' && effect.at === 'workspace')) { once = false; throw busy; }
    lifeStore.commit(id, effects);
  });
  r.send('first'); await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('ready');
  expect(r.run.mock.calls.map(call => call[0])).toEqual(['identity', 'workspace', 'capabilities', 'platform', 'cli', 'process', 'channel']);
  r.send('next'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(2);
  await r.owner.signOut();
});

it('recovers a fault commit after teardown fails under a lock, and the effect chain accepts a new start', async () => {
  const r = rig(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
  r.teardown.mockImplementationOnce(async () => { lock(); throw new Error('teardown failed'); });
  r.exit();
  await vi.waitFor(() => expect(r.failed).toHaveBeenCalledTimes(2));
  blocker.exec('COMMIT');
  await r.owner.quiescent('s');
  expect(r.owner.read('s')).toMatchObject({ kind: 'failed', failure: { message: 'teardown failed' } });
  r.owner.start('s'); await r.owner.quiescent('s');
  r.send('after-fault'); await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('ready');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  await r.owner.signOut();
});

it('applies an interrupt queued behind a failed stage commit before running that stage', async () => {
  const r = rig(); await r.owner.signIn('A');
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'run-stage' && effect.at === 'workspace')) {
      once = false;
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    }
    lifeStore.commit(id, effects);
  });
  r.send('queued');
  // Let identity finish and queue its uncommitted stage-ok, without running the retry timer.
  for (let n = 0; n < 20 && !r.failed.mock.calls.length; n++) await Promise.resolve();
  expect(r.failed).toHaveBeenCalledTimes(1);
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  expect(r.run.mock.calls.map(call => call[0])).toEqual(['identity']);
  expect(r.owner.read('s').kind).toBe('dormant');
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.signOut();
});

it('contains a permanent fault-commit failure without poisoning the next explicit start', async () => {
  const r = rig(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
  r.teardown.mockRejectedValueOnce(new Error('teardown failed'));
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'write-hold' && effect.hold?.reason === 'effect-fault')) { once = false; throw new Error('disk full'); }
    lifeStore.commit(id, effects);
  });
  r.exit(); await r.owner.quiescent('s');
  expect(r.failed.mock.calls.map(call => String(call[1]))).toEqual(['Error: teardown failed', 'Error: disk full']);
  r.owner.start('s'); await r.owner.quiescent('s');
  r.send('after-fault'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  await r.owner.signOut();
});


function interrupted(id = 'interrupted') {
  const input = { sessionId: 's', messageId: id, text: 'original envelope', kind: 'session-direct' as const };
  const seq = lifeStore.enqueue(input).seq;
  lifeStore.commit('s', [{ e: 'write-receipt', seq, receipt: { state: 'dispatching', attempt: 1 as never } }]);
  return { input, seq };
}

it('restart claims unknown without dispatch; a durable echo settles it automatically without starting', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  expect(lifeStore.row('s', seq).state).toBe('unknown');
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.reconcileUnknownRows('s', async input => { expect(input.id).toBe('interrupted'); return { state: 'received', nativeReceiptId: 'native-user' }; });
  expect(lifeStore.row('s', seq).state).toBe('accepted');
  expect(r.run).not.toHaveBeenCalled(); expect(r.dispatch).not.toHaveBeenCalled();
});

it('a missing echo stays unknown across opening; only an explicit resend dispatches the original row once', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  await r.owner.reconcileUnknownRows('s', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }));
  expect(lifeStore.row('s', seq).state).toBe('unknown'); expect(r.dispatch).not.toHaveBeenCalled();
  await Promise.all([r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const })), r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }))]);
  await vi.waitFor(() => expect(r.dispatch).toHaveBeenCalledTimes(1));
  expect(lifeStore.row('s', seq).message).toMatchObject({ id: 'interrupted', text: 'original envelope' });
  expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM session_pending WHERE session_id='s'").get()).toEqual({ n: 1 });
});

it('rechecks history on click: a newly landed input is accepted without a second dispatch', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  await r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'received', nativeReceiptId: 'native-after-open' }));
  expect(lifeStore.row('s', seq).state).toBe('accepted'); expect(r.dispatch).not.toHaveBeenCalled();
});

it('history read failure cannot requeue an unknown receipt', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  await expect(r.owner.retryUnknownRow('s', 'interrupted', async () => { throw new Error('history unavailable'); })).rejects.toThrow('history unavailable');
  expect(lifeStore.row('s', seq).state).toBe('unknown'); expect(r.dispatch).not.toHaveBeenCalled();
});

it('sign-out during history lookup cannot requeue or dispatch on another account', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  let finish!: (value: NativeInputEvidence) => void;
  const lookup = new Promise<NativeInputEvidence>(resolve => { finish = resolve; });
  let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
  const retry = r.owner.retryUnknownRow('s', 'interrupted', () => { entered(); return lookup; });
  await began; await r.owner.signOut(); finish({ state: 'absent', reason: 'native_input_absent' });
  await expect(retry).rejects.toThrow('session changed');
  expect(lifeStore.row('s', seq).state).toBe('unknown'); expect(r.dispatch).not.toHaveBeenCalled();
});

it('rejects a foreign account and never clears an archived session hold', async () => {
  const { seq } = interrupted(); let own = true; const r = rig(async () => own); await r.owner.signIn('A');
  own = false;
  await expect(r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }))).rejects.toThrow('account cannot');
  own = true; await r.owner.interrupt('s', { k: 'interrupt', reason: 'archive' });
  await expect(r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }))).rejects.toThrow('cannot resend');
  expect(lifeStore.row('s', seq).state).toBe('unknown'); expect(r.dispatch).not.toHaveBeenCalled();
});


it('a stop completed during recovery wins over the older resend intent', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  let finish!: (value: NativeInputEvidence) => void, entered!: () => void;
  const lookup = new Promise<NativeInputEvidence>(resolve => { finish = resolve; });
  const began = new Promise<void>(resolve => { entered = resolve; });
  const retry = r.owner.retryUnknownRow('s', 'interrupted', () => { entered(); return lookup; });
  await began;
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  expect(r.owner.read('s')).toMatchObject({ kind: 'dormant', hold: 'user-stop' });
  finish({ state: 'absent', reason: 'native_input_absent' });
  await expect(retry).rejects.toThrow('session changed');
  expect(lifeStore.row('s', seq).state).toBe('unknown');
  expect(r.owner.read('s')).toMatchObject({ kind: 'dormant', hold: 'user-stop' });
  expect(r.run).not.toHaveBeenCalled(); expect(r.dispatch).not.toHaveBeenCalled();
});

it('a fresh explicit resend after the stop is allowed without replaying a second copy', async () => {
  interrupted(); const r = rig(); await r.owner.signIn('A');
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  await r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }));
  await vi.waitFor(() => expect(r.dispatch).toHaveBeenCalledTimes(1));
});


it('a refused foreign input never creates an entry that a later sign-out can mutate', async () => {
  const { seq } = interrupted();
  lifeStore.commit('s', [{ e: 'write-receipt', seq, receipt: { state: 'unknown' } }]);
  const r = rig(async () => false); await r.owner.signIn('A');
  await expect(r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }))).rejects.toThrow('account cannot');
  await r.owner.signOut();
  expect(lifeStore.read('s').hold).toBeNull();
  expect(lifeStore.row('s', seq).state).toBe('unknown');
});


it('sign-out during the ownership check cannot create a late recovery entry', async () => {
  const { seq } = interrupted();
  lifeStore.commit('s', [{ e: 'write-receipt', seq, receipt: { state: 'unknown' } }]);
  let check: () => Promise<boolean> = async () => false;
  const r = rig(() => check()); await r.owner.signIn('A');
  let finish!: (value: boolean) => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  check = () => { entered(); return new Promise<boolean>(resolve => { finish = resolve; }); };
  const retry = r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }));
  await began; await r.owner.signOut(); finish(true);
  await expect(retry).rejects.toThrow('account cannot');
  check = async () => false;
  await r.owner.signIn('B'); await r.owner.signOut();
  expect(lifeStore.read('s').hold).toBeNull(); expect(lifeStore.row('s', seq).state).toBe('unknown');
});

function refused(id = 'refused', kind: 'session-direct' | 'inbox-batch' = 'session-direct') {
  const seq = kind === 'inbox-batch'
    ? lifeStore.enqueue({ sessionId: 's', text: 'batch', kind, sources: [] }).seq
    : lifeStore.enqueue({ sessionId: 's', messageId: id, text: 'typed words', kind }).seq;
  lifeStore.commit('s', [{ e: 'write-receipt', seq, receipt: { state: 'failed', cause: { name: 'AdmissionDeclined', message: 'declined' } } }]);
  return seq;
}

it('a failed row a person resends goes out once, without a history lookup, as the same row', async () => {
  const seq = refused(); const r = rig(); await r.owner.signIn('A');
  expect(r.owner.read('s').pending.items.find(row => row.messageId === 'refused')).toMatchObject({ state: 'failed', resendable: true, discardable: true });
  const lookup = vi.fn(async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }));
  await Promise.all([r.owner.retryUnknownRow('s', 'refused', lookup), r.owner.retryUnknownRow('s', 'refused', lookup)]);
  await vi.waitFor(() => expect(r.dispatch).toHaveBeenCalledTimes(1));
  await r.owner.quiescent('s');
  expect(lookup).not.toHaveBeenCalled();
  expect(lifeStore.row('s', seq).state).toBe('accepted');
  expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM session_pending WHERE session_id='s'").get()).toEqual({ n: 1 });
});

it('discarding a failed or unknown row removes it and its message for good', async () => {
  refused(); interrupted(); const r = rig(); await r.owner.signIn('A');
  expect(r.owner.read('s').pending.items.map(row => row.state)).toEqual(['failed', 'unknown']);
  r.owner.discardRow('s', 'refused'); r.owner.discardRow('s', 'interrupted');
  expect(r.owner.read('s').pending.items).toEqual([]);
  expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id IN ('refused','interrupted')").get()).toEqual({ n: 0 });
  await r.owner.signOut();
  const again = rig(); await again.owner.signIn('A');
  expect(again.owner.read('s').pending.items).toEqual([]);
  expect(again.dispatch).not.toHaveBeenCalled();
});

it('a failed inbox batch is neither resent nor discarded by hand: its sources were told', async () => {
  refused('batch', 'inbox-batch'); const r = rig(); await r.owner.signIn('A');
  const row = r.owner.read('s').pending.items[0]!;
  expect(row).toMatchObject({ state: 'failed', resendable: false, discardable: false });
  await r.owner.retryUnknownRow('s', row.messageId, async () => ({ state: 'absent' as const, reason: 'native_input_absent' as const }));
  expect(() => r.owner.discardRow('s', row.messageId)).toThrow('cannot be discarded');
  expect(r.dispatch).not.toHaveBeenCalled();
});


it('reconciles an actual timeout exit against native receipt automatically, without dispatching a duplicate', async () => {
  const lookup = vi.fn<NativeInputLookup>(async () => ({ state: 'received', nativeReceiptId: 'native-received-before-timeout' }));
  const r = rig(async () => true, lookup); await r.owner.signIn('A');
  r.dispatch.mockRejectedValueOnce(Object.assign(new Error('native receipt timed out'), { code: 'prompt_admission_timeout' }));
  const row = r.send('timeout-received');
  await vi.waitFor(() => expect(lifeStore.row('s', row.seq).state).toBe('accepted'));
  expect(lookup).toHaveBeenCalledWith({ id: 'timeout-received', text: 'timeout-received' });
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  expect(r.teardown).toHaveBeenCalledTimes(1);
  expect(fixture.sqlite.prepare('SELECT native_receipt_id FROM session_pending WHERE seq = ?').get(row.seq))
    .toEqual({ native_receipt_id: 'native-received-before-timeout' });
  await r.owner.signOut();
});

it.each(['native_input_absent', 'native_source_changed', 'native_record_incomplete', 'native_tail_does_not_cover_history'])(
  'a timeout with %s remains durably unknown and never starts an automatic retry', async reason => {
    const lookup: NativeInputLookup = async () => reason === 'native_input_absent'
      ? { state: 'absent', reason } : { state: 'incomplete', reason };
    const r = rig(async () => true, lookup); await r.owner.signIn('A');
    r.dispatch.mockRejectedValueOnce(new Error('native receipt timed out'));
    const row = r.send('timeout-unresolved');
    await vi.waitFor(() => expect(lifeStore.row('s', row.seq)).toMatchObject({ state: 'unknown', failure: { code: reason } }));
    await r.owner.quiescent('s');
    expect(r.dispatch).toHaveBeenCalledTimes(1);
    await r.owner.signOut();
    const restarted = rig(async () => true, lookup); await restarted.owner.signIn('A');
    await vi.waitFor(() => expect(lifeStore.row('s', row.seq).failure?.code).toBe(reason));
    expect(restarted.dispatch).not.toHaveBeenCalled();
    await restarted.owner.signOut();
  });

it('persists incomplete evidence and refuses even an explicit replay until history can be checked', async () => {
  const { seq } = interrupted(); const r = rig(); await r.owner.signIn('A');
  await expect(r.owner.retryUnknownRow('s', 'interrupted', async () => ({ state: 'incomplete', reason: 'native_source_changed' })))
    .rejects.toThrow('native_source_changed');
  expect(lifeStore.row('s', seq)).toMatchObject({ state: 'unknown', failure: { code: 'native_source_changed' } });
  expect(r.dispatch).not.toHaveBeenCalled();
});

it('a concurrent discard during native lookup cannot resurrect the original input', async () => {
  interrupted(); const r = rig(); await r.owner.signIn('A');
  const lookup = Promise.withResolvers<NativeInputEvidence>();
  const entered = Promise.withResolvers<void>();
  const reconcile = r.owner.reconcileUnknownRows('s', () => { entered.resolve(); return lookup.promise; });
  await entered.promise;
  r.owner.discardRow('s', 'interrupted');
  lookup.resolve({ state: 'received', nativeReceiptId: 'late' });
  await reconcile;
  expect(r.owner.read('s').pending.items).toEqual([]);
  expect(r.dispatch).not.toHaveBeenCalled();
});

it.each([true, false])('reconciles a real native file after timeout with received=%s and an empty stored projection', async received => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-native-receipt-'));
  const path = join(directory, 'rollout-fixture-native-session.jsonl');
  const text = renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromType: 'agent', fromId: 'session:sender',
    messageId: 'msg:timeout-source', at: 'now', content: 'original task' });
  const metadata = JSON.stringify({ type: 'session_meta', payload: { id: 'native-session' } }) + '\n';
  const recorded = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
  await writeFile(path, metadata);
  const lookup: NativeInputLookup = async input => (await readNativeInputTail({ harness: 'codex', providerSessionId: 'native-session', roots: [] }, { path })).find(input);
  const r = rig(async () => true, lookup);
  try {
    await r.owner.signIn('A');
    r.dispatch.mockImplementationOnce(async () => {
      if (received) await writeFile(path, metadata + recorded);
      throw Object.assign(new Error('native receipt timed out'), { code: 'prompt_admission_timeout' });
    });
    const row = r.owner.enqueue({ sessionId: 's', messageId: 'host-timeout-input', text, kind: 'session-direct' });
    await vi.waitFor(() => expect(lifeStore.row('s', row.seq)).toMatchObject(received
      ? { state: 'accepted' } : { state: 'unknown', failure: { code: 'native_input_absent' } }));
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM session_turns WHERE session_id = 's'").get()).toEqual({ n: 0 });
    expect(r.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM session_pending WHERE session_id = 's'").get()).toEqual({ n: 1 });
  } finally { await r.owner.signOut(); await rm(directory, { recursive: true, force: true }); }
});
// Covers both the final await for one input and the interval between inputs sharing a native tail.
it.each([2, 3])('native binding change at ownership check %i cannot settle stale evidence', async changeCheck => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-review-native-binding-'));
  const path = join(directory, 'rollout-fixture-native-session.jsonl');
  mocks.nativePath = path;
  fixture.sqlite.prepare("UPDATE sessions SET provider = 'codex', provider_session_id = 'native-session' WHERE id = 's'").run();
  const messages = ['first', 'second'].map(id => ({ id, text: renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromType: 'agent', fromId: 'session:sender', messageId: `msg:${id}`, at: 'now', content: 'task' }) }));
  const seqs = messages.map(({ id, text }) => {
    const seq = lifeStore.enqueue({ sessionId: 's', messageId: id, text, kind: 'session-direct' }).seq;
    lifeStore.commit('s', [{ e: 'write-receipt', seq, receipt: { state: 'dispatching', attempt: 1 as never } }]);
    return seq;
  });
  await writeFile(path, [JSON.stringify({ type: 'session_meta', payload: { id: 'native-session' } }), ...messages.map(({ text }) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))].join('\n')+'\n');
  let checks = 0;
  let reconciling = false;
  const r = rig(async () => {
    if (reconciling && ++checks === changeCheck) fixture.sqlite.prepare("UPDATE sessions SET provider_session_id = 'replacement' WHERE id = 's'").run();
    return true;
  });
  try {
    await r.owner.signIn('A'); reconciling = true;
    await r.owner.reconcileUnknownRows('s', nativePendingInputLookup('s'));
    expect(lifeStore.row('s', seqs[0]!).state).toBe(changeCheck === 2 ? 'unknown' : 'accepted');
    expect(fixture.sqlite.prepare("SELECT provider_session_id AS id FROM sessions WHERE id='s'").get()).toEqual({ id: 'replacement' });
    expect(lifeStore.row('s', seqs[1]!).state).toBe('unknown');
    expect(lifeStore.row('s', seqs[1]!)).toMatchObject({ state: 'unknown', failure: { code: 'native_session_changed' } });
    expect(r.dispatch).not.toHaveBeenCalled();
  } finally { await r.owner.signOut(); await rm(directory, { recursive: true, force: true }); }
});
