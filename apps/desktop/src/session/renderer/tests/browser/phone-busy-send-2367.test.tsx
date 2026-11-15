import { afterEach, expect, it, vi } from 'vitest';
import { act, useSyncExternalStore } from 'react';
import { page } from 'vitest/browser';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline, type AgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import type { LifeView } from '@shared/core/sessions/session-life';

/*
 * #2367 (probe): one sent message is one bubble entity from the tap until its native message is in the record.
 * Every pending source the phone draws (composer outbox, a new session's first prompt, a restart's startup row)
 * must carry the identity the host admits that input under, so the transcript unit never changes key and the
 * bubble node is never replaced.
 */

const store = <T,>(initial: T) => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => { value = next; for (const listener of listeners) listener(); },
    useValue: () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => value),
  };
};

const hostLife = vi.hoisted(() => ({ store: null as null | { get: () => LifeView | null; useValue: () => LifeView | null } }));
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({
  useSessionLifeView: () => {
    const view = hostLife.store!.useValue();
    return { view, error: null, current: () => hostLife.store!.get() };
  },
}));
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})), machineRpc: () => ({ sessions: { getStoredHistory: vi.fn() } }) }));

const life = store<LifeView | null>(null);
hostLife.store = life;
const timeline = store<AgentWatchTimeline>(emptyAgentWatchTimeline());

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  Object.assign(state(), { accountId: null, rows: EMPTY, valid: () => false });
  life.set(null);
  timeline.set(emptyAgentWatchTimeline());
});

const SESSION = 'phone-task';
// Current hosts report each row's admission time; the native turn starts at that same time.
const SENT_AT = Date.now();
const hostIdle = (): LifeView => ({ sessionId: SESSION, version: 2, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null,
  pending: { count: 0, items: [] } });

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

const props = { deviceId: 'device', sessionId: SESSION, agentName: 'Agent', nativeRecord: true, sessionRuntime: 'acp' as const, respondingItemId: null,
  onRespond: vi.fn(), onSend: vi.fn(), sending: false, agentWorking: false, onStop: vi.fn(), stopping: false, onLoadOlder: vi.fn(async () => {}) };

async function mount(node: React.ReactElement) {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, node, { contacts: {} });
}

const bash = (turn: string, done: boolean) => ({ kind: 'execute-tool-call' as const, id: `${turn}:tool`, seq: 1, toolCallId: `${turn}-call`, title: 'python3 -c sleep', status: done ? 'done' as const : 'running' as const,
  command: 'python3 -c "import time; time.sleep(30)"', at: SENT_AT - 30_000, ...(done ? { completedAt: SENT_AT - 1000 } : {}) });
/** As the page's record has it: a running turn is the record's active turn under its live id; storage renumbers it when it settles. */
const turn = (n: number, userId: string, text: string, stage: 'running' | 'done', startedAt: number): TranscriptTurn => {
  const id = stage === 'running' ? `live:${n}` : `${SESSION}:turn:s${n}`;
  return { id, referenceId: `live:${n}`, seq: n, initiator: 'user', startedAt, ...(stage === 'done' ? { endedAt: startedAt + 30_000, outcome: { kind: 'done' as const } } : {}),
    items: [{ kind: 'message', role: 'user', id: userId, seq: 0, text, _meta: { guguClientMessageId: userId, guguNativeMessageId: `p${n}` } },
      bash(id, stage === 'done'), ...(stage === 'done' ? [{ kind: 'message' as const, role: 'assistant' as const, id: `${id}:m2`, seq: 2, text: '完成。' }] : [])] };
};
// A person's own send is a `session-direct` row on the host, which the delivery projection draws too.
const hostRowB = (messageId: string, text: string): LifeView => ({ sessionId: SESSION, version: 3, kind: 'ready', stage: null, hold: null, failure: null,
  lastExit: null, nativeSession: null, pending: { count: 1, items: [{ seq: 1, messageId, kind: 'session-direct', text, preview: text, sentAt: SENT_AT - 20_000, state: 'dispatching', failure: null }] } });

it.each([
  ['the sender row ends after this page has the previous turn (as measured on the phone)', false],
  ['the host acknowledges, ending the sender row, before this page has the previous turn', true],
])('a message the send queue releases before this page has the previous turn: one bubble row from the moment it is drawn (%s)', async (_label, earlyAck) => {
  const id = 'busy-client-id', text = 'sent while the agent is busy', startA = SENT_AT - 60_000;
  const aRunning = turn(0, 'a-client', 'first task', 'running', startA), aDone = turn(0, 'a-client', 'first task', 'done', startA);
  const row = (extra: object) => ({ id, sessionId: SESSION, accountId: 'owner', deviceId: 'device', text, createdAt: SENT_AT - 20_000, ...extra });
  const working = store(true);
  timeline.set({ ...emptyAgentWatchTimeline(), turns: [aRunning] });
  Object.assign(state(), { accountId: 'owner', rows: [row({ queued: true, sendQueue: { order: 1 } })], valid: () => true });
  function Page() {
    return <SessionConversation {...props} agentWorking={working.useValue()} timeline={timeline.useValue()} pendingSends={[]} />;
  }
  await mount(<Page />);
  await frames();
  // Every frame: the bubble's card and row nodes, and its row index.
  const serial = new WeakMap<Element, number>(); let next = 1;
  const samples: { phase: string; card: number | null; row: number | null; index: string | null }[] = [];
  let phase = 'queued', sampling = true;
  const tick = () => {
    const card = [...harness.container.querySelectorAll('[data-user-card]')].find(e => (e as HTMLElement).innerText.includes(text)) ?? null;
    const rowEl = card?.closest('[data-row-kind]') ?? null;
    for (const e of [card, rowEl]) if (e && !serial.has(e)) serial.set(e, next++);
    samples.push({ phase, card: card ? serial.get(card)! : null, row: rowEl ? serial.get(rowEl)! : null, index: card?.closest('[data-index]')?.getAttribute('data-index') ?? null });
    if (sampling) requestAnimationFrame(tick);
  };
  tick();
  const step = async (name: string, change: () => void) => { phase = name; await act(async () => change()); await frames(); };
  // The observer read a record with the previous turn complete and released the input after it; this page still draws
  // that turn running.
  await step('released', () => { working.set(false);
    state().rows = [row({ queued: false, releasedFromQueue: true, baseline: ['a-client'], afterTurnId: aDone.id }) as never]; changed(); });
  // The host has it; this page still has the previous turn running.
  await step('host-row', () => { life.set(hostRowB(id, text)); if (earlyAck) { state().rows = []; changed(); } working.set(true); });
  await step('page-record', () => { timeline.set({ ...emptyAgentWatchTimeline(), turns: [aDone] }); });
  // As measured on the phone, the sender's outbox row ends after this page has the previous turn.
  await step('next-running', () => { timeline.set({ ...emptyAgentWatchTimeline(), turns: [aDone, turn(1, id, text, 'running', SENT_AT)] }); life.set(hostIdle()); state().rows = []; changed(); });
  await step('landed', () => { timeline.set({ ...emptyAgentWatchTimeline(), turns: [aDone, turn(1, id, text, 'done', SENT_AT)] }); working.set(false); });
  sampling = false;
  const drawn = samples.filter(sample => sample.card !== null);
  expect(drawn.length).toBeGreaterThanOrEqual(6);
  // Once drawn, it is never taken back, and it is the same card and row node, at the same index, in every frame.
  expect(samples.slice(samples.indexOf(drawn[0])).every(sample => sample.card !== null)).toBe(true);
  expect(new Set(drawn.map(sample => `${sample.card}/${sample.row}/${sample.index}`))).toEqual(new Set([`${drawn[0].card}/${drawn[0].row}/${drawn[0].index}`]));
  // It is drawn once this page has the previous turn, not before.
  expect(drawn[0].phase).toBe('page-record');
  expect(harness.container.querySelector(`[data-user-card="${id}"]`)?.textContent).toContain(text);
});

it('the queue keeps showing a released message until this page can place it', async () => {
  const id = 'waiting-client-id', text = 'waiting for this page to catch up', startA = SENT_AT - 60_000;
  timeline.set({ ...emptyAgentWatchTimeline(), turns: [turn(0, 'a-client', 'first task', 'running', startA)] });
  Object.assign(state(), { accountId: 'owner', rows: [{ id, sessionId: SESSION, accountId: 'owner', deviceId: 'device', text, createdAt: SENT_AT,
    queued: false, releasedFromQueue: true, baseline: ['a-client'], afterTurnId: `${SESSION}:turn:s0` }], valid: () => true });
  function Page() {
    return <SessionConversation {...props} timeline={timeline.useValue()} pendingSends={[]} />;
  }
  await mount(<Page />);
  await frames();
  expect(harness.container.querySelector(`[data-user-card="${id}"]`)).toBeNull();
  expect(harness.container.textContent).toContain(text);
  await act(async () => { timeline.set({ ...emptyAgentWatchTimeline(), turns: [turn(0, 'a-client', 'first task', 'done', startA)] }); });
  await until('the released message is drawn once the page has its previous turn', () => !!harness.container.querySelector(`[data-user-card="${id}"]`));
});
