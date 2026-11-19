import { noopLogger } from '@gugu/session-shared/logger';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { SessionLife } from '../sessions/session-life';
import type { LegAdapter } from '../sessions/session-life-adapter';
import { lifeStore } from '../sessions/session-pending';
import { executeAgentDelivery, type AgentScheduleDeliveryDeps } from './actions/deliverToAgent';
import { AutomationScheduler } from './automation-scheduler';
import { createAgentSchedule, getAutomation, markDueCronRunsQueued, startCreatingSession } from './repo';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('./actions/sessionCreate', () => ({ executeSessionCreate: vi.fn() }));

const NOW = Date.UTC(2026, 10, 17, 0);
let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/repo'); INSERT INTO sessions(id,project_id,title,config) VALUES ('s','p','S',json_object('version','1','type','acp','agentDisplayName','S'))");
});
afterEach(() => { fixture.close(); mocks.db = undefined; vi.useRealTimers(); });

function runtime() {
  let platform: () => Promise<void> = async () => {};
  const chargesAtDispatch: number[] = [];
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => {
    const row = fixture.sqlite.prepare('SELECT error FROM automation_runs LIMIT 1').get() as { error: string | null };
    chargesAtDispatch.push(row.error ? JSON.parse(row.error).deliveryRecoveryAttempts : 0);
    return { result: 'accepted', nativeReceiptId: 'controlled' };
  });
  const owner = new SessionLife({ logger: noopLogger, sessions: () => ['s'], store: () => lifeStore,
    adapter: () => ({ leg: 'acp', timing: 'next-tool-call',
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        if (at === 'platform') await platform();
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing: 'next-tool-call' }) as StageOut[K];
      }, dispatch, teardown: async () => {}, onExit: () => () => {} }),
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true,
    markRead: async () => {}, reportFailure: async () => {}, publish: () => {}, removed: () => {}, failed: vi.fn(), now: Date.now });
  return { owner, dispatch, chargesAtDispatch, platform: (next: () => Promise<void>) => { platform = next; } };
}

// A hard process loss has no finally/signOut. Park the old controlled continuation forever,
// then reconstruct both owners from SQLite; no model, process or live client is involved.
it.each(['reserved-before-start', 'started-before-admission', 'admitted-before-done', 'unknown-ack-before-run-update'] as const)(
  'reconciles the same durable run and input after interruption at %s', async cutAt => {
    const { automation, nextRun } = await createAgentSchedule({ agentSessionId: 's', name: 'scheduled input',
      prompt: 'continue this task', provider: 'codex', triggerConfig: { expr: '', tz: 'UTC', at: NOW + 120_000 } });
    vi.setSystemTime(NOW + 120_000);
    await markDueCronRunsQueued(Date.now());
    const run = (await startCreatingSession(nextRun!.id))!;
    const before = runtime(); await before.owner.signIn('A');
    before.platform(async () => { throw new Error('controlled initial startup failure'); });
    if (cutAt === 'unknown-ack-before-run-update') before.dispatch.mockRejectedValueOnce(new Error('ACK outcome unknown'));
    const cut = Promise.withResolvers<void>();
    const identities: string[] = [];
    const scopes: string[] = [];
    const envelopes: string[] = [];
    const inputId = `scheduled:${run.id}`;
    let seq: ReturnType<SessionLife['enqueue']>['seq'];

    function delivery(r: ReturnType<typeof runtime>, interrupt: boolean): AgentScheduleDeliveryDeps {
      return { sessionPresent: async () => true, async deliver(sessionId, envelope, text, scope, receipt, reserve) {
        identities.push(receipt.id); scopes.push(scope); envelopes.push(envelope(inputId, text));
        seq = r.owner.enqueue({ sessionId, messageId: inputId, text: envelopes[0]!, kind: 'session-direct' }).seq;
        await r.owner.quiescent('s');
        let recovery = r.owner.recoverQueuedDelivery(sessionId, inputId, false);
        if (recovery.state === 'needed' && await reserve(recovery.cause)) {
          if (interrupt && cutAt === 'reserved-before-start') {
            cut.resolve(); return new Promise(() => {});
          }
          r.platform(interrupt && cutAt === 'started-before-admission' ? () => new Promise(() => {}) : async () => {});
          recovery = r.owner.recoverQueuedDelivery(sessionId, inputId, true);
          if (interrupt && cutAt === 'started-before-admission') {
            await vi.waitFor(() => expect(r.owner.read('s').stage?.at).toBe('platform'));
            cut.resolve(); return new Promise(() => {});
          }
          await r.owner.quiescent('s');
        }
        const state = lifeStore.row('s', seq).state;
        if (interrupt && (cutAt === 'admitted-before-done' || cutAt === 'unknown-ack-before-run-update')) {
          expect(state).toBe(cutAt === 'admitted-before-done' ? 'accepted' : 'unknown');
          cut.resolve(); return new Promise(() => {});
        }
        if (state === 'unknown') throw Object.assign(new Error('ACK outcome unknown'), { code: 'SESSION_DIRECT_OUTCOME_UNKNOWN' });
        return { id: inputId, status: state === 'accepted' ? 'delivered' : 'queued', recovery };
      } };
    }

    void executeAgentDelivery(automation, run, () => {}, delivery(before, true));
    await cut.promise;
    const frozen = fixture.sqlite.prepare('SELECT status, error FROM automation_runs WHERE id=?').get(run.id) as { status: string; error: string };
    expect(frozen.status).toBe('creating_session');
    expect(JSON.parse(frozen.error).deliveryRecoveryAttempts).toBe(1);
    expect((await getAutomation(automation.id))?.enabled).toBe(true);

    const after = runtime(); await after.owner.signIn('A'); await after.owner.quiescent('s');
    const steps: AutomationRun[] = [];
    const claimed: AutomationRun[] = [];
    const scheduler = new AutomationScheduler({ onRunStep: step => { steps.push(step); }, onScheduledRunChanged: () => {} },
      (current, pending, onStep) => { claimed.push(pending); return executeAgentDelivery(current, pending, onStep, delivery(after, false)); });
    scheduler.start();
    try {
      await vi.waitFor(async () => expect((await getAutomation(automation.id))?.enabled).toBe(false));
      expect(steps[0]).toMatchObject({ id: run.id, status: 'queued', error: { deliveryRecoveryAttempts: 1 } });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ id: run.id, error: { deliveryRecoveryAttempts: 1 } });
      expect(steps.at(-1)).toMatchObject(cutAt === 'unknown-ack-before-run-update'
        ? { id: run.id, status: 'failed', error: { message: 'ACK outcome unknown' } }
        : { id: run.id, status: 'done', error: null });
      expect(new Set(identities)).toEqual(new Set([run.id]));
      expect(new Set(scopes)).toEqual(new Set([`automation:${automation.id}`]));
      expect(new Set(envelopes).size).toBe(1);
      const dispatched = [...before.dispatch.mock.calls, ...after.dispatch.mock.calls].map(call => call[1].message.id);
      expect(dispatched).toEqual([inputId]);
      if (cutAt !== 'unknown-ack-before-run-update') {
        expect([...before.chargesAtDispatch, ...after.chargesAtDispatch]).toEqual([cutAt === 'reserved-before-start' ? 2 : 1]);
      }
      expect(fixture.sqlite.prepare('SELECT count(*) FROM session_pending').pluck().get()).toBe(1);
    } finally { scheduler.stop(); await after.owner.signOut(); }
  });
