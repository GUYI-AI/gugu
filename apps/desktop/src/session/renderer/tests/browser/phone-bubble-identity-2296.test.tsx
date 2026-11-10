import { afterEach, expect, it, vi } from 'vitest';
import { act, useSyncExternalStore } from 'react';
import { page } from 'vitest/browser';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { PendingPrompt } from '@gugu/session-chat-ui';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline, type AgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { settlePendingSends } from '@/mobile/agent-watch/pending-sends';
import { useTimelineSession, type SessionpageTimelineClient } from '@/mobile/agent-watch/use-timeline-session';
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import type { LifeView } from '@shared/core/sessions/session-life';

/*
 * #2296 on the phone: one sent message is one bubble entity from the tap until its native message is in the record.
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
const hostRow = (messageId: string, text: string): LifeView => ({ sessionId: SESSION, version: 1, kind: 'starting', stage: null, hold: null, failure: null,
  lastExit: null, nativeSession: null, pending: { count: 1, items: [{ seq: 1, messageId, kind: 'ordinary', text, preview: text, sentAt: SENT_AT, state: 'queued', failure: null }] } });
const hostIdle = (): LifeView => ({ sessionId: SESSION, version: 2, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null,
  pending: { count: 0, items: [] } });
// The record stores a submitted input under its client identity (#2299); storage renumbers only the turn prefix.
const landed = (clientId: string, text: string): AgentWatchTimeline => ({ ...emptyAgentWatchTimeline(), turns: [{
  id: `${SESSION}:turn:s0`, seq: 0, initiator: 'user', startedAt: SENT_AT,
  items: [{ kind: 'message', role: 'user', id: clientId, seq: 0, text, _meta: { guguClientMessageId: clientId, guguNativeMessageId: 'provider-uuid' } }],
} satisfies TranscriptTurn] });

/** Samples the user bubbles on every frame, as the owner's frame-by-frame check does. */
function sampleBubbles(host: HTMLElement) {
  const original = host.querySelector('[data-user-card]');
  const samples: { phase: string; count: number; sameNode: boolean; id: string | null }[] = [];
  let phase = 'pending';
  let sampling = true;
  const record = () => {
    const bubbles = host.querySelectorAll('[data-user-card]');
    samples.push({ phase, count: bubbles.length, sameNode: bubbles[0] === original, id: bubbles[0]?.getAttribute('data-user-card') ?? null });
  };
  const sample = () => {
    record();
    if (sampling) requestAnimationFrame(sample);
  };
  // The state before the first change is a sample too: rows are keyed by index, so an id change can keep the
  // node while the unit (its height and tween registration) is replaced underneath it.
  record();
  requestAnimationFrame(sample);
  return {
    original,
    samples,
    phase: (next: string) => { phase = next; },
    stop: () => { sampling = false; },
  };
}

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const expectOneEntity = (run: ReturnType<typeof sampleBubbles>, id: string) =>
  expect(run.samples).toEqual(run.samples.map(sample => ({ phase: sample.phase, count: 1, sameNode: true, id })));

const props = { deviceId: 'device', sessionId: SESSION, agentName: 'Agent', nativeRecord: true, sessionRuntime: 'acp' as const, respondingItemId: null,
  onRespond: vi.fn(), onSend: vi.fn(), sending: false, agentWorking: false, onStop: vi.fn(), stopping: false, onLoadOlder: vi.fn(async () => {}) };

async function mount(node: React.ReactElement) {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, node, { contacts: {} });
}

it('composer outbox: the sender row, the host row and the native message are one bubble entity', async () => {
  const text = 'from the phone composer';
  const input = { id: 'composer-client-id', sessionId: SESSION, accountId: 'owner', deviceId: 'device', text, createdAt: Date.now(), queued: false };
  Object.assign(state(), { accountId: 'owner', rows: [input], valid: () => true });
  function Page() {
    return <SessionConversation {...props} timeline={timeline.useValue()} pendingSends={[]} />;
  }
  await mount(<Page />);
  await until('the sender row is drawn', () => !!harness.container.querySelector('[data-user-card]'));
  const run = sampleBubbles(harness.container);
  run.phase('host-row');
  await act(async () => { life.set(hostRow(input.id, text)); state().rows = []; changed(); });
  await frames();
  run.phase('landed');
  await act(async () => { timeline.set(landed(input.id, text)); life.set(hostIdle()); });
  await frames();
  run.stop();
  expect(run.samples.length).toBeGreaterThanOrEqual(6);
  expectOneEntity(run, input.id);
});

it('restart startup row: the starting prompt, the host row and the native message are one bubble entity', async () => {
  const text = 'continue after restart';
  const id = 'restart-client-id';
  // As useSessionRestart builds it from the host row.
  const startup = store<PendingPrompt | null>({ id, text, starting: 'starting', held: true, sentAt: SENT_AT });
  function Page() {
    return <SessionConversation {...props} timeline={timeline.useValue()} startupPrompt={startup.useValue()} pendingSends={[]} />;
  }
  life.set(hostRow(id, text));
  await mount(<Page />);
  await until('the startup row is drawn', () => !!harness.container.querySelector('[data-user-card]'));
  const run = sampleBubbles(harness.container);
  await frames();
  run.phase('landed');
  await act(async () => { timeline.set(landed(id, text)); life.set(hostIdle()); startup.set(null); });
  await frames();
  run.stop();
  expect(run.samples.length).toBeGreaterThanOrEqual(4);
  expectOneEntity(run, id);
});

const idle: SessionpageTimelineClient = {
  fetchSnapshot: () => new Promise(() => {}), fetchAfter: () => new Promise(() => {}), fetchOlder: () => new Promise(() => {}),
  fetchToolImage: () => new Promise(() => {}), subscribeSession: async () => null, unsubscribeSession: async () => null,
  subscribeSessionEvents: () => () => {}, onLinkChange: () => () => {}, sendSessionText: async () => null,
  cancelSessionTurn: async () => ({ cancelled: false }), respondToSettlement: () => new Promise(() => {}),
};

it('new session first prompt: the optimistic send, the creation row and the native message are one bubble entity', async () => {
  const text = 'start the new task';
  // The id the phone sent with its create request; the host admits the creation turn under it.
  const firstPrompt = { id: 'first-prompt-client-id', text, sentAt: SENT_AT };
  function Page() {
    const current = timeline.useValue();
    // The page's own optimistic send, settled against the same record the transcript reads.
    const { pendingSends } = useTimelineSession(idle, 'mobile', 'device', SESSION, false, firstPrompt);
    return <SessionConversation {...props} timeline={current} pendingSends={settlePendingSends(pendingSends, current.turns, current.queuedPrompts)} />;
  }
  await mount(<Page />);
  await until('the first prompt is drawn at once', () => !!harness.container.querySelector('[data-user-card]'));
  const run = sampleBubbles(harness.container);
  run.phase('creation-row');
  await act(async () => { life.set(hostRow(firstPrompt.id, text)); });
  await frames();
  // Checked before landing: the creation row is where a page-minted id used to replace the bubble.
  expectOneEntity(run, firstPrompt.id);
  run.phase('landed');
  await act(async () => { timeline.set(landed(firstPrompt.id, text)); life.set(hostIdle()); });
  await frames();
  run.stop();
  expect(run.samples.length).toBeGreaterThanOrEqual(6);
  expectOneEntity(run, firstPrompt.id);
});

/*
 * Mixed versions: a new phone talking to a host from before #2296. That host ignores `initialMessageId` and admits
 * the first prompt as `<session>:creation:0`, exactly as dev does. It must not be worse than before the fix: never a
 * second bubble, never a lost message, at most the one id change the first prompt always had.
 */
it.each([
  ['the host reports its creation row before the record lands', true],
  ['the record lands before the phone sees the creation row', false],
])('new phone + old host: one bubble, no lost message, at most the pre-fix id change (%s)', async (_label, seesRow) => {
  const text = 'start the task on an old host';
  const firstPrompt = { id: 'first-prompt-client-id', text, sentAt: SENT_AT };
  const hostId = `${SESSION}:creation:0`;
  function Page() {
    const current = timeline.useValue();
    const { pendingSends } = useTimelineSession(idle, 'mobile', 'device', SESSION, false, firstPrompt);
    return <SessionConversation {...props} timeline={current} pendingSends={settlePendingSends(pendingSends, current.turns, current.queuedPrompts)} />;
  }
  await mount(<Page />);
  await until('the first prompt is drawn at once', () => !!harness.container.querySelector('[data-user-card]'));
  const run = sampleBubbles(harness.container);
  if (seesRow) {
    run.phase('creation-row');
    await act(async () => { life.set(hostRow(hostId, text)); });
    await frames();
  }
  run.phase('landed');
  await act(async () => { timeline.set(landed(hostId, text)); life.set(hostIdle()); });
  await frames();
  run.stop();
  expect(run.samples.length).toBeGreaterThanOrEqual(4);
  // Never a second bubble, never an empty frame.
  expect(run.samples.every(sample => sample.count === 1)).toBe(true);
  // At most the one change the first prompt had before the fix: the phone's id, then the host's.
  const ids = run.samples.map(sample => sample.id).filter((id, index, all) => index === 0 || id !== all[index - 1]);
  expect(ids).toEqual([firstPrompt.id, hostId]);
  // The message is there, as the host recorded it.
  expect(harness.container.querySelector(`[data-user-card="${hostId}"]`)?.textContent).toContain(text);
});
