import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { ExtensionsService } from './extensions-service';

/**
 * #1928 (API 43): an App's control of the schedules of the agent its binding's conversation is with — the person's own
 * agent, in their private conversation with it. The real schedule store (migrated database), the real automations service
 * and the real App service; the cloud (who is in the chat, whose agent it is), the account and the roster are stand-ins.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const SESSION = 'agent-session';
const ELSE_SESSION = 'other-session';
const ID = 'routines';
const NOW = Date.UTC(2026, 10, 11, 1, 0, 0);

const state = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  root: '',
  service: undefined as unknown,
  token: '',
  roster: [] as unknown[],
  blocked: new Map<string, Error>(),
  cloud: { kind: 'dm' as string | null, members: [] as string[], owned: true, error: false },
  afterCloud: undefined as (() => void) | undefined,
  taps: new Set<(channel: string, data: unknown) => void>(),
  told: [] as string[],
  rosterReads: 0,
  onTell: undefined as (() => void) | undefined,
  provisions: [] as unknown[],
  panel: undefined as unknown,
  panelWords: new Set<{ assistantId: string; changed(): void }>(),
  thisDevice: '',
}));
vi.mock('@main/core/sessions/session-family', () => ({ otherMachines: () => ({ isThisDevice: async (id: string) => id === state.thisDevice }) }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('Test database not initialized'); return state.db; } }));
vi.mock('@main/lib/events', () => ({
  events: { emit: (event: { name: string }, data: unknown) => { for (const tap of [...state.taps]) tap(event.name, data); } },
  tapMainEvents: (tap: (channel: string, data: unknown) => void) => { state.taps.add(tap); return () => { state.taps.delete(tap); }; },
}));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: vi.fn() }));
vi.mock('@main/core/automations/actions/sessionCreate', () => ({ executeSessionCreate: vi.fn() }));
vi.mock('@main/core/sessions/session-orchestration', () => ({
  messageSessionFrom: async (_envelope: unknown, _session: string, text: string) => { state.told.push(text); state.onTell?.(); return { id: 'deferred' }; },
}));
vi.mock('@main/core/automations/assistant-panel-schedule-preparation', () => ({ prepareAgentScheduleChanges: async () => state.blocked }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.token }));
vi.mock('./assistant-panel-changes', () => ({
  onAssistantPanelChanged: (_owner: string, assistantId: string, changed: () => void) => {
    const word = { assistantId, changed };
    state.panelWords.add(word);
    return () => { state.panelWords.delete(word); };
  },
}));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service, extensionsRoot: () => state.root }));
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userIdFromSupabaseAccessToken: (token: string) => token,
  listAgents: async () => { state.rosterReads += 1; return state.roster; },
}));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const answer = () => {
        state.afterCloud?.();
        if (state.cloud.error) return { data: null, error: { message: 'down' } };
        if (table === 'chats') return { data: state.cloud.kind ? { kind: state.cloud.kind } : null, error: null };
        if (table === 'active_members') return { data: state.cloud.members.map((user_id) => ({ user_id })), error: null };
        if (table === 'agent_provisions') return { data: state.provisions, error: null };
        return { data: state.cloud.owned ? { id: AGENT } : null, error: null };
      };
      const query = {
        select: () => query, eq: () => query, abortSignal: () => query,
        maybeSingle: async () => answer(),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(answer).then(resolve, reject),
      };
      return query;
    },
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async () => (state.panel as FakePanel).rpc(name, args),
    }),
  }),
}));

const HOME_DEVICE = '55000000-0000-4000-8000-000000000005';
const K1 = 'a1000000-0000-4000-8000-0000000000a1';
const K2 = 'a2000000-0000-4000-8000-0000000000a2';
type PanelRow = { key: string; revision: number; data: Record<string, unknown>; deleted: boolean; stale?: boolean; updated: number };
type PanelChange = { request: string; revision: number; key: string; status: 'pending' | 'failed' | 'applied' | 'superseded'; operation: string };

/**
 * The assistant's panel in the cloud, as `assistant_panel_snapshot` / `assistant_panel_commit` keep it (gugu-supabase
 * 20261026041500_assistant_panel_state.sql): a resent operation id with the same request answers that change's status, a
 * different one is 23505; a stale revision is PT409; a newer change to a resource supersedes its outstanding one. Only the
 * home's acknowledgement (`homeApplies`, `homeRefuses`) moves a change on.
 */
class FakePanel {
  revision = 10;
  ready = true;
  down = false;
  /** The commit is made but its answer is lost on the way back. */
  loseAnswer = false;
  /** The commit never arrives (reads still do). */
  dropCommit = false;
  calls = 0;
  rows = new Map<string, PanelRow>();
  changes = new Map<string, PanelChange>();
  put(key: string, data: Record<string, unknown>) {
    this.rows.set(key, { key, revision: ++this.revision, data, deleted: false, updated: Date.now() });
  }
  tell() { for (const word of [...state.panelWords]) if (word.assistantId === AGENT) word.changed(); }
  homeApplies() {
    for (const change of this.changes.values()) if (change.status === 'pending' || change.status === 'failed') change.status = 'applied';
    // The home publishes what it now has, as it does after each applied change.
    for (const row of this.rows.values()) if (!row.deleted) Object.assign(row, { revision: ++this.revision, updated: Date.now() });
    this.tell();
  }
  homeRefuses(operationId: string) { this.changes.get(operationId)!.status = 'failed'; this.tell(); }
  pendingOf() { return [...this.changes.entries()].filter(([, change]) => change.status === 'pending').map(([id]) => id); }
  item(row: PanelRow) {
    return { assistant_user_id: AGENT, owner_user_id: OWNER, domain: 'schedules', resource_key: row.key, device_id: HOME_DEVICE,
      revision: String(row.revision), data: row.deleted ? {} : row.data, body_item_id: null, body_sha256: null,
      deleted_at: row.deleted ? new Date(row.updated).toISOString() : null, observed_at: null, updated_at: new Date(row.updated).toISOString(),
      ...(row.stale ? { stale_at: new Date(row.updated).toISOString() } : {}) };
  }
  rpc(name: string, args: Record<string, unknown>) {
    this.calls += 1;
    if (this.down) throw new Error('fetch failed');
    if (args.p_assistant !== AGENT) return { data: null, error: { message: 'not available', code: '42501' }, status: 403 };
    if (name === 'assistant_panel_snapshot') {
      const marker = { key: '__collection__', revision: 1, data: { state: this.ready ? 'ready' : 'error' }, deleted: false, updated: NOW };
      return { data: { version: 1, revision: String(this.revision), items: [marker, ...this.rows.values()].map((row) => this.item(row)),
        application: [...this.changes.entries()].filter(([, change]) => change.status === 'pending' || change.status === 'failed')
          .map(([operationId, change]) => ({ operationId, revision: String(change.revision), domain: 'schedules', resourceKey: change.key, status: change.status, errorCode: null })) },
      error: null };
    }
    if (name !== 'assistant_panel_commit') throw new Error(`unexpected ${name}`);
    if (this.dropCommit) throw new Error('fetch failed');
    const operationId = String(args.p_operation_id);
    const request = JSON.stringify([args.p_domain, args.p_resource_key, args.p_expected_revision, args.p_operation, args.p_data, args.p_device_id]);
    const existing = this.changes.get(operationId);
    if (existing) {
      if (existing.request !== request) return { data: null, error: { message: 'used for a different request', code: '23505' }, status: 409 };
      return { data: { operationId, revision: String(existing.revision), status: existing.status }, error: null };
    }
    const row = this.rows.get(String(args.p_resource_key));
    if (String(row?.revision ?? 0) !== String(args.p_expected_revision)) return { data: null, error: { message: 'changed', code: 'PT409' }, status: 409 };
    for (const change of this.changes.values()) if (change.key === row!.key && (change.status === 'pending' || change.status === 'failed')) change.status = 'superseded';
    const revision = ++this.revision;
    Object.assign(row!, { revision, updated: Date.now() });
    if (args.p_operation === 'remove') row!.deleted = true;
    else row!.data = { ...row!.data, enabled: args.p_operation === 'enable' };
    this.changes.set(operationId, { request, revision, key: row!.key, status: 'pending', operation: String(args.p_operation) });
    this.tell();
    if (this.loseAnswer) throw new Error('fetch failed');
    return { data: { operationId, revision: String(revision), status: 'pending' }, error: null };
  }
}

const { appBoundSchedules, appBoundScheduleControl, watchBoundSchedules, SCHEDULES_HEARD_AFTER_MS } = await import('./app-bound-schedules');
const { automationsService } = await import('@main/core/automations/automations-service');
const { runAgentScheduleAction } = await import('@main/core/automations/agent-schedules');
const { setEnabledAndTell } = await import('@main/core/automations/person-schedule-changes');
const { getAutomation, insertRun, listAgentSchedules } = await import('@main/core/automations/repo');

let fixture: Awaited<ReturnType<typeof openFixture>>;
const roots: string[] = [];

function manifest(actions = ['unread', 'schedules', 'schedules:control'], apiVersion = 43) {
  return { id: ID, name: 'Routines', version: '1.0.0', apiVersion, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: actions.map((action) => (action === 'unread' ? 'chat:unread' : `chat:${action}`)), bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'main', title: 'Routines' }] } };
}
function installApp(actions?: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-schedules-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Routines</p>');
  state.root = path.join(root, 'installed');
  const service = new ExtensionsService(state.root);
  const install = (value = manifest(actions)) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(value));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: OWNER });
  };
  install();
  service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
  state.service = service;
  return { service, install };
}

const list = (extra: Record<string, unknown> = {}) => appBoundSchedules(ID, { name: 'main', ...extra });
const control = (change: Record<string, unknown>) => appBoundScheduleControl(ID, { name: 'main', ...change });
let ops = 0;
const op = () => `op-${String(++ops).padStart(6, '0')}`;
async function own(prompt = 'Check the inbox', extra: Record<string, unknown> = { cron: '0 8 * * *', tz: 'Asia/Shanghai' }) {
  const row = await runAgentScheduleAction({ sessionId: SESSION, projectId: 'project-1', provider: 'claude' }, { action: 'schedule_create', prompt, ...extra } as never);
  return (row as { schedule_id: string }).schedule_id;
}
async function current(scheduleId: string) {
  const answer = await list();
  if (answer.state !== 'ready') throw new Error(`not ready: ${answer.state}`);
  return answer.schedules.find((schedule) => schedule.id === scheduleId)!;
}
const rows = () => fixture.sqlite.prepare('SELECT id, enabled, deleted_at FROM automations ORDER BY created_at').all() as { id: string; enabled: number; deleted_at: string | null }[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fixture = await openFixture('empty');
  state.db = fixture.db;
  fixture.sqlite.prepare(`INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'Home', '/home', 0, 0)`).run();
  for (const id of [SESSION, ELSE_SESSION]) {
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, provider, runtime, config) VALUES (?, 'project-1', 'claude', 'acp', json_object('version', '1', 'type', 'pty', 'agentDisplayName', 'Agent'))`).run(id);
  }
  Object.assign(state, { token: OWNER, blocked: new Map(), afterCloud: undefined, told: [], rosterReads: 0, onTell: undefined,
    cloud: { kind: 'dm', members: [OWNER, AGENT], owned: true, error: false },
    roster: [{ gugu_user_id: AGENT, status: 'active', cache: { emdash_session_id: SESSION, sessionpage_owner_user_id: OWNER } }] });
  state.taps.clear();
  state.panelWords.clear();
  state.provisions = [];
  state.thisDevice = 'this-computer';
  state.panel = new FakePanel();
  installApp();
});

afterEach(() => {
  automationsService.stop();
  fixture.close();
  state.db = undefined;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});

describe('listing the bound agent\'s schedules', () => {
  it('gives each its stable id, revision, times, state and runs — and nothing of the agent, session or chat', async () => {
    const daily = await own('Check the inbox');
    const once = await own('Call the bank', { at: '2026-11-11T12:00', tz: 'Asia/Shanghai', title: 'Bank' });
    await own('Not this agent\'s', { cron: '0 9 * * *' }).then(async (id) => {
      fixture.sqlite.prepare('UPDATE automations SET agent_session_id = ? WHERE id = ?').run(ELSE_SESSION, id.slice('schedule:'.length));
    });
    const answer = await list();
    expect(answer).toMatchObject({ name: 'main', state: 'ready' });
    const schedules = (answer as { schedules: unknown[] }).schedules;
    expect(schedules).toEqual([
      { id: daily, revision: expect.any(String), title: 'Check the inbox', prompt: 'Check the inbox', at: null, cron: '0 8 * * *', tz: 'Asia/Shanghai',
        state: 'active', nextRunAt: '2026-11-12T00:00:00.000Z', lastRun: null, updatedAt: new Date(NOW).toISOString() },
      { id: once, revision: expect.any(String), title: 'Bank', prompt: 'Call the bank', at: '2026-11-11T04:00:00.000Z', cron: null, tz: 'Asia/Shanghai',
        state: 'active', nextRunAt: '2026-11-11T04:00:00.000Z', lastRun: null, updatedAt: new Date(NOW).toISOString() },
    ]);
    for (const secret of [SESSION, ELSE_SESSION, AGENT, CHAT, OWNER, 'project-1']) expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it('no conversation chosen is unbound; an agent living elsewhere is elsewhere; unapplied saved changes are unavailable', async () => {
    (state.service as ExtensionsService).setConversationUnreadBinding(OWNER, ID, 'main', null);
    expect(await list()).toEqual({ name: 'main', state: 'unbound' });
    (state.service as ExtensionsService).setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    state.roster = [];
    expect(await list()).toEqual({ name: 'main', state: 'elsewhere' });
    await expect(control({ operationId: op(), op: 'register', prompt: 'x', cron: '0 8 * * *' })).rejects.toMatchObject({ code: 'elsewhere' });
    state.roster = [{ gugu_user_id: AGENT, status: 'active', cache: { emdash_session_id: SESSION, sessionpage_owner_user_id: OWNER } }];
    state.blocked = new Map([[SESSION, new Error('PANEL_PREPARATION_TIMEOUT')]]);
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    await expect(control({ operationId: op(), op: 'register', prompt: 'x', cron: '0 8 * * *' })).rejects.toMatchObject({ code: 'unavailable' });
    state.blocked = new Map();
    state.cloud.error = true;
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    expect(rows()).toEqual([]);
  });
});

describe('who may reach them', () => {
  it('refuses a conversation that is not the person\'s private one with an agent they own', async () => {
    const before = await own();
    for (const set of [
      () => { state.cloud.owned = false; },
      () => { state.cloud.kind = 'group'; },
      () => { state.cloud.members = [OWNER, AGENT, OTHER]; },
      () => { state.cloud.members = [AGENT, OTHER]; },
    ]) {
      Object.assign(state.cloud, { kind: 'dm', members: [OWNER, AGENT], owned: true });
      set();
      await expect(list()).rejects.toMatchObject({ code: 'denied' });
      await expect(control({ operationId: op(), op: 'pause', scheduleId: before, revision: 'r' })).rejects.toMatchObject({ code: 'denied' });
    }
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.enabled).toBe(1);
  });

  it('another account reaches nothing of this account\'s selection, and a switch mid-request is refused with nothing changed', async () => {
    const id = await own();
    const { revision } = await current(id);
    state.token = OTHER;
    expect(await list()).toEqual({ name: 'main', state: 'unbound' });
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'not-found' });
    state.afterCloud = () => { state.token = OTHER; };
    state.token = OWNER;
    const reads = state.rosterReads;
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    // Refused right after the wait it changed in: not even this computer's roster is read for the old account.
    expect(state.rosterReads).toBe(reads);
    state.token = OWNER;
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    // Signed out while the cloud answered.
    state.afterCloud = () => { state.token = ''; };
    state.token = OWNER;
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    expect(rows()[0]!.enabled).toBe(1);
  });

  it('a forged handle, owner, agent, session or chat is refused before anything; a stale selection mid-request is refused', async () => {
    const id = await own();
    const { revision } = await current(id);
    for (const extra of [{ handle: 'h' }, { ownerId: OWNER }, { agentId: AGENT }, { agent: `user:${AGENT}` }, { sessionId: SESSION }, { chat: CHAT }, { chatId: CHAT }]) {
      await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision, ...extra })).rejects.toMatchObject({ code: 'invalid' });
      await expect(list(extra)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const bad of [{ scheduleId: SESSION }, { scheduleId: id.slice('schedule:'.length) }, { operationId: 'short' }, { op: 'cancel' }, { revision: '' }]) {
      await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision, ...bad })).rejects.toMatchObject({ code: 'invalid' });
    }
    // The person chooses the conversation again while the call waits on the cloud: that call's selection is stale.
    state.afterCloud = () => { (state.service as ExtensionsService).setConversationUnreadBinding(OWNER, ID, 'main', CHAT); };
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    expect(rows()[0]!.enabled).toBe(1);
  });

  it('inspecting needs chat:schedules; changing needs the declared schedules:control action and its grant', async () => {
    const id = await own();
    const { revision } = await current(id);
    const service = state.service as ExtensionsService;
    service.setPermissionGranted(ID, 'chat:schedules', false);
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    service.setPermissionGranted(ID, 'chat:schedules', true);
    service.setPermissionGranted(ID, 'chat:schedules:control', false);
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    expect(await list()).toMatchObject({ state: 'ready' });
    // Declared to inspect only: there is no control to grant.
    installApp(['unread', 'schedules']);
    expect(await list()).toMatchObject({ state: 'ready' });
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    expect(rows()[0]!.enabled).toBe(1);
  });

  it('a schedule of another agent\'s is missing, and untouched', async () => {
    const theirs = await own('Theirs');
    fixture.sqlite.prepare('UPDATE automations SET agent_session_id = ? WHERE id = ?').run(ELSE_SESSION, theirs.slice('schedule:'.length));
    const receipt = await control({ operationId: op(), op: 'remove', scheduleId: theirs, revision: 'anything' });
    expect(receipt).toMatchObject({ status: 'missing', scheduleId: theirs });
    expect(await getAutomation(theirs.slice('schedule:'.length))).not.toBeNull();
  });
});

describe('changing them, idempotently, through the host\'s schedule store', () => {
  it('registers once per operation id: the replay answers the same receipt and makes no second schedule', async () => {
    const operationId = 'b6f1c2d4-0000-4000-8000-000000000001';
    const change = { operationId, op: 'register', title: 'Stretch', prompt: 'Remind them to stretch', cron: '0 15 * * 1-5', tz: 'Asia/Shanghai' };
    const [first, racing] = await Promise.all([control(change), control(change)]);
    expect(first).toEqual({ name: 'main', operationId, op: 'register', status: 'applied', scheduleId: expect.stringMatching(/^schedule:/), revision: expect.any(String), at: new Date(NOW).toISOString() });
    expect(racing).toEqual(first);
    vi.setSystemTime(NOW + 60_000);
    expect(await control(change)).toEqual(first);
    expect(await listAgentSchedules(SESSION)).toHaveLength(1);
    expect(await current(first.scheduleId)).toMatchObject({ title: 'Stretch', prompt: 'Remind them to stretch', cron: '0 15 * * 1-5', state: 'active', revision: (first as { revision: string }).revision });
    // The agent is told once, not woken: deferred to its next turn.
    expect(state.told).toEqual([expect.stringContaining(`added the schedule "Stretch" (${first.scheduleId}) for you from an App`)]);
    // Another change under the same id is the caller's mistake.
    await expect(control({ ...change, title: 'Other' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await listAgentSchedules(SESSION)).toHaveLength(1);
  });

  it('an interrupted registration, asked again, finds the schedule it made instead of making another', async () => {
    const operationId = 'interrupted-0001';
    const change = { operationId, op: 'register', prompt: 'Water the plants', at: '2026-11-12T09:00', tz: 'Asia/Shanghai' };
    const first = await control(change);
    // As if the host stopped after the effect, before the answer was written: only the record from before it is left.
    const file = path.join(state.root, '.app-schedule-receipts.json');
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, { receipt?: unknown; pending?: unknown }>>;
    const entry = Object.values(kept)[0]![operationId]!;
    delete entry.receipt;
    entry.pending = { trigger: { expr: '', tz: 'Asia/Shanghai', at: Date.UTC(2026, 10, 12, 1, 0, 0) } };
    writeFileSync(file, JSON.stringify(kept));
    expect(await control(change)).toMatchObject({ status: 'applied', scheduleId: first.scheduleId });
    expect(await listAgentSchedules(SESSION)).toHaveLength(1);
  });

  it('pause and resume keep the id, leave a run under way alone, and a stale revision is a conflict that changes nothing', async () => {
    const id = await own();
    const raw = id.slice('schedule:'.length);
    const automation = (await getAutomation(raw))!;
    const running = await insertRun({ automationId: raw, triggerConfigSnapshot: automation.triggerConfig!, agentConfigSnapshot: automation.agentConfig!,
      sessionConfigSnapshot: null, scheduledAt: NOW - 1000, deadlineAt: null, status: 'starting_agent', triggerKind: 'cron', startedAt: NOW - 1000 });
    const { revision } = await current(id);
    vi.setSystemTime(NOW + 1000);
    const paused = await control({ operationId: op(), op: 'pause', scheduleId: id, revision });
    expect(paused).toMatchObject({ status: 'applied', scheduleId: id });
    expect(paused.status === 'applied' && paused.revision).not.toBe(revision);
    expect(await current(id)).toMatchObject({ id, state: 'paused', nextRunAt: null });
    // The old revision is stale now: a conflict, with the current one, and the schedule stays paused.
    const stale = await control({ operationId: op(), op: 'resume', scheduleId: id, revision });
    expect(stale).toMatchObject({ status: 'conflict', scheduleId: id, revision: (paused as { revision: string }).revision });
    expect(await current(id)).toMatchObject({ state: 'paused' });
    vi.setSystemTime(NOW + 2000);
    const resumed = await control({ operationId: op(), op: 'resume', scheduleId: id, revision: (paused as { revision: string }).revision });
    expect(resumed).toMatchObject({ status: 'applied', scheduleId: id });
    expect(await current(id)).toMatchObject({ id, state: 'active', nextRunAt: '2026-11-12T00:00:00.000Z' });
    // Removing waits for the run under way rather than stopping it — and refuses before touching anything, its next run kept.
    await expect(control({ operationId: op(), op: 'remove', scheduleId: id, revision: (resumed as { revision: string }).revision })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await current(id)).toMatchObject({ state: 'active', nextRunAt: '2026-11-12T00:00:00.000Z', revision: (resumed as { revision: string }).revision });
    expect(fixture.sqlite.prepare('SELECT status FROM automation_runs WHERE id = ?').get(running.id)).toEqual({ status: 'starting_agent' });
    expect(await listAgentSchedules(SESSION)).toHaveLength(1);
    expect(state.told).toEqual([expect.stringContaining('paused your schedule'), expect.stringContaining('turned your schedule')]);
  });

  it('updates the title and the time, never what it asks; removes; each answer is kept under its operation id', async () => {
    const id = await own('Check the inbox');
    let { revision } = await current(id);
    await expect(control({ operationId: op(), op: 'update', scheduleId: id, revision, prompt: 'Something else' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(control({ operationId: op(), op: 'update', scheduleId: id, revision })).rejects.toMatchObject({ code: 'invalid' });
    await expect(control({ operationId: op(), op: 'update', scheduleId: id, revision, cron: 'not a cron' })).rejects.toMatchObject({ code: 'invalid' });
    vi.setSystemTime(NOW + 1000);
    const updated = await control({ operationId: op(), op: 'update', scheduleId: id, revision, title: 'Inbox', cron: '30 7 * * *', tz: 'Asia/Shanghai' });
    expect(updated).toMatchObject({ status: 'applied', scheduleId: id });
    expect(await current(id)).toMatchObject({ id, title: 'Inbox', prompt: 'Check the inbox', cron: '30 7 * * *', nextRunAt: '2026-11-11T23:30:00.000Z' });
    ({ revision } = await current(id));
    const removeId = op();
    const removed = await control({ operationId: removeId, op: 'remove', scheduleId: id, revision });
    expect(removed).toMatchObject({ status: 'applied', scheduleId: id, revision: null });
    expect(await list()).toMatchObject({ state: 'ready', schedules: [] });
    expect(await control({ operationId: removeId, op: 'remove', scheduleId: id, revision })).toEqual(removed);
    expect(state.told).toEqual([expect.stringContaining('moved your schedule'), expect.stringContaining('cancelled your schedule')]);
  });
});

describe('authority on completion', () => {
  it('a change that completes after the App lost its grant is withheld from it; its receipt stays, for when it is granted again', async () => {
    const id = await own();
    const { revision } = await current(id);
    const service = state.service as ExtensionsService;
    const operationId = op();
    // The person withdraws control while the change is being made (here: as the agent is told).
    state.onTell = () => service.setPermissionGranted(ID, 'chat:schedules:control', false);
    await expect(control({ operationId, op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    state.onTell = undefined;
    expect(await current(id)).toMatchObject({ state: 'paused' });
    await expect(control({ operationId, op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    service.setPermissionGranted(ID, 'chat:schedules:control', true);
    expect(await control({ operationId, op: 'pause', scheduleId: id, revision })).toMatchObject({ status: 'applied', scheduleId: id });
    expect(state.told).toHaveLength(1);
  });
});

describe('lifecycle is the host\'s', () => {
  it('disabling or uninstalling the App leaves every schedule as it was and takes its authority; enabling restores it', async () => {
    const { install } = installApp();
    const id = await own();
    const paused = await own('Paused one');
    await setEnabledAndTell(paused.slice('schedule:'.length), false);
    const before = rows();
    const { revision } = await current(id);
    const service = state.service as ExtensionsService;
    service.setEnabled(ID, false);
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    await expect(control({ operationId: op(), op: 'pause', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    expect(rows()).toEqual(before);
    service.setEnabled(ID, true);
    expect(await current(id)).toMatchObject({ revision, state: 'active' });
    service.uninstall(ID);
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    await expect(control({ operationId: op(), op: 'remove', scheduleId: id, revision })).rejects.toMatchObject({ code: 'denied' });
    expect(rows()).toEqual(before);
    // Installed again, it has no selection until the person chooses again — and the schedules are still there.
    install();
    expect(await list()).toEqual({ name: 'main', state: 'unbound' });
    expect(rows()).toEqual(before);
  });

  it('hears the agent\'s schedules change, from any path, until the grant goes — then stops listening for good', async () => {
    const heard = vi.fn();
    const ended = vi.fn();
    const settle = () => new Promise((resolve) => setTimeout(resolve, SCHEDULES_HEARD_AFTER_MS * 4));
    const wait = { timeout: SCHEDULES_HEARD_AFTER_MS * 40 };
    const stop = await watchBoundSchedules(ID, { name: 'main' }, heard, ended);
    expect(state.taps.size).toBe(1);
    // The agent's own schedule_create, then the person's own switch.
    const id = await own('Agent made this');
    await vi.waitFor(() => expect(heard).toHaveBeenCalled(), wait);
    await settle();
    let count = heard.mock.calls.length;
    await setEnabledAndTell(id.slice('schedule:'.length), false);
    await vi.waitFor(() => expect(heard.mock.calls.length).toBeGreaterThan(count), wait);
    await settle();
    // Another agent's schedule is not this binding's.
    count = heard.mock.calls.length;
    await runAgentScheduleAction({ sessionId: ELSE_SESSION, projectId: 'project-1', provider: 'claude' }, { action: 'schedule_create', prompt: 'x', cron: '0 9 * * *' });
    await settle();
    expect(heard).toHaveBeenCalledTimes(count);
    expect(heard.mock.calls.every((call) => call.length === 0)).toBe(true);
    // The grant withdrawn: the next change finds it gone, the watch ends itself and says nothing.
    (state.service as ExtensionsService).setPermissionGranted(ID, 'chat:schedules', false);
    await setEnabledAndTell(id.slice('schedule:'.length), true);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce(), wait);
    expect(heard).toHaveBeenCalledTimes(count);
    expect(state.taps.size).toBe(0);
    // Granted again, that watch stays gone: the page asks again if it wants to hear.
    (state.service as ExtensionsService).setPermissionGranted(ID, 'chat:schedules', true);
    await setEnabledAndTell(id.slice('schedule:'.length), false);
    await settle();
    expect(heard).toHaveBeenCalledTimes(count);
    stop();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('a watch is refused without a selection, and closing it stops only that watch', async () => {
    (state.service as ExtensionsService).setConversationUnreadBinding(OWNER, ID, 'main', null);
    await expect(watchBoundSchedules(ID, { name: 'main' }, vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'not-found' });
    (state.service as ExtensionsService).setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const first = await watchBoundSchedules(ID, { name: 'main' }, vi.fn(), vi.fn());
    const second = vi.fn();
    const keep = await watchBoundSchedules(ID, { name: 'main' }, second, vi.fn());
    first();
    expect(state.taps.size).toBe(1);
    await own();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce(), { timeout: SCHEDULES_HEARD_AFTER_MS * 40 });
    keep();
    expect(state.taps.size).toBe(0);
  });
});

describe('the person\'s assistant living on another computer or in the cloud: its panel, as the built-in list', () => {
  const panel = () => state.panel as FakePanel;
  const assistantElsewhere = () => {
    state.roster = [];
    state.provisions = [{ agent_user_id: AGENT, device_id: HOME_DEVICE, member_key: 'assistant', phase: 'completed', created_at: '2026-11-01T00:00:00Z', agent: { removed_at: null } }];
    panel().put(K1, { title: 'Check the inbox', prompt: 'Check the inbox', at: null, cron: '0 8 * * *', tz: 'Asia/Shanghai', enabled: true,
      nextRunAt: Date.UTC(2026, 10, 12, 0, 0, 0), lastRun: { status: 'done', at: NOW - 3_600_000, errorCode: null } });
    panel().put(K2, { title: 'Bank', prompt: 'Call the bank', at: NOW + 3 * 3_600_000, cron: '', tz: 'Asia/Shanghai', enabled: true,
      nextRunAt: NOW + 3 * 3_600_000, lastRun: null });
  };
  const s1 = `schedule:${K1}`;
  const s2 = `schedule:${K2}`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, SCHEDULES_HEARD_AFTER_MS * 4));
  const wait = { timeout: SCHEDULES_HEARD_AFTER_MS * 40 };

  it('lists what its home published; unpublished, stale, unresolved or unreachable is unavailable; an agent of this computer never asks the cloud', async () => {
    assistantElsewhere();
    const answer = await list();
    expect(answer).toEqual({ name: 'main', state: 'ready', schedules: [
      { id: s1, revision: '11', title: 'Check the inbox', prompt: 'Check the inbox', at: null, cron: '0 8 * * *', tz: 'Asia/Shanghai', state: 'active',
        nextRunAt: '2026-11-12T00:00:00.000Z', lastRun: { status: 'done', at: new Date(NOW - 3_600_000).toISOString() }, updatedAt: new Date(NOW).toISOString() },
      { id: s2, revision: '12', title: 'Bank', prompt: 'Call the bank', at: new Date(NOW + 3 * 3_600_000).toISOString(), cron: null, tz: 'Asia/Shanghai', state: 'active',
        nextRunAt: new Date(NOW + 3 * 3_600_000).toISOString(), lastRun: null, updatedAt: new Date(NOW).toISOString() },
    ] });
    for (const secret of [AGENT, HOME_DEVICE, OWNER, CHAT]) expect(JSON.stringify(answer)).not.toContain(secret);
    panel().ready = false;
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    panel().ready = true;
    panel().rows.get(K2)!.stale = true;
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    panel().rows.get(K2)!.stale = false;
    panel().down = true;
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    panel().down = false;
    // Not the person's assistant: no panel, as before.
    state.provisions = [];
    expect(await list()).toEqual({ name: 'main', state: 'elsewhere' });
    // Living here again: the schedule store directly, never the cloud's copy.
    state.roster = [{ gugu_user_id: AGENT, status: 'active', cache: { emdash_session_id: SESSION, sessionpage_owner_user_id: OWNER } }];
    const calls = panel().calls;
    expect(await list()).toEqual({ name: 'main', state: 'ready', schedules: [] });
    expect(panel().calls).toBe(calls);
  });

  it('still listed on this computer after a move away: its home\'s panel, never the schedules left here; listed and at home here: the store', async () => {
    const left = await own('Left behind');
    assistantElsewhere();
    state.roster = [{ gugu_user_id: AGENT, status: 'active', cache: { emdash_session_id: SESSION, sessionpage_owner_user_id: OWNER } }];
    expect(await list()).toMatchObject({ state: 'ready', schedules: [expect.objectContaining({ id: s1 }), expect.objectContaining({ id: s2 })] });
    expect(await control({ operationId: op(), op: 'pause', scheduleId: s1, revision: '11' })).toMatchObject({ status: 'pending', scheduleId: s1 });
    expect([...panel().changes.values()]).toEqual([expect.objectContaining({ key: K1, operation: 'disable', status: 'pending' })]);
    await expect(control({ operationId: op(), op: 'register', prompt: 'x', cron: '0 8 * * *' })).rejects.toMatchObject({ code: 'elsewhere' });
    expect(rows()).toEqual([{ id: left.slice('schedule:'.length), enabled: 1, deleted_at: null }]);
    // Its home is this computer: the schedule store here, and the panel is not asked.
    state.thisDevice = HOME_DEVICE;
    vi.setSystemTime(NOW + 1000);
    const calls = panel().calls;
    expect(await list()).toMatchObject({ state: 'ready', schedules: [expect.objectContaining({ id: left })] });
    expect(await control({ operationId: op(), op: 'pause', scheduleId: left, revision: (await current(left)).revision })).toMatchObject({ status: 'applied', scheduleId: left });
    expect(rows()).toEqual([{ id: left.slice('schedule:'.length), enabled: 0, deleted_at: null }]);
    expect(panel().calls).toBe(calls);
    expect(panel().changes.size).toBe(1);
  });

  it('pauses, resumes and removes by the panel\'s commit at the revision read: pending until its home applies it, the same id telling where it is', async () => {
    assistantElsewhere();
    const pauseId = op();
    const paused = await control({ operationId: pauseId, op: 'pause', scheduleId: s1, revision: '11' });
    expect(paused).toEqual({ name: 'main', operationId: pauseId, op: 'pause', status: 'pending', scheduleId: s1, revision: '13', at: new Date(NOW).toISOString() });
    expect([...panel().changes.values()]).toEqual([expect.objectContaining({ key: K1, operation: 'disable', status: 'pending',
      request: JSON.stringify(['schedules', K1, '11', 'disable', {}, HOME_DEVICE]) })]);
    expect(await current(s1)).toMatchObject({ state: 'paused', nextRunAt: null, revision: '13' });
    // Asked again while its home has not applied it: still pending, and no second change.
    vi.setSystemTime(NOW + 60_000);
    expect(await control({ operationId: pauseId, op: 'pause', scheduleId: s1, revision: '11' })).toEqual(paused);
    expect(panel().changes.size).toBe(1);
    panel().homeApplies();
    expect(await control({ operationId: pauseId, op: 'pause', scheduleId: s1, revision: '11' })).toEqual({ ...paused, status: 'applied' });
    // Settled: answered from the record alone.
    const calls = panel().calls;
    expect(await control({ operationId: pauseId, op: 'pause', scheduleId: s1, revision: '11' })).toEqual({ ...paused, status: 'applied' });
    expect(panel().calls).toBe(calls);
    // A stale revision is a conflict with the current one, and nothing is sent.
    const { revision } = await current(s1);
    expect(await control({ operationId: op(), op: 'resume', scheduleId: s1, revision: '13' })).toMatchObject({ status: 'conflict', scheduleId: s1, revision });
    const resumed = await control({ operationId: op(), op: 'resume', scheduleId: s1, revision });
    expect(resumed).toMatchObject({ status: 'pending', scheduleId: s1 });
    expect(await current(s1)).toMatchObject({ state: 'active', revision: (resumed as { revision: string }).revision });
    panel().homeApplies();
    const removeId = op();
    const removing = { operationId: removeId, op: 'remove', scheduleId: s2, revision: (await current(s2)).revision };
    const removed = await control(removing);
    expect(removed).toMatchObject({ status: 'pending', scheduleId: s2, revision: null });
    expect(await list()).toMatchObject({ state: 'ready', schedules: [expect.objectContaining({ id: s1 })] });
    panel().homeApplies();
    expect(await control(removing)).toMatchObject({ status: 'applied', revision: null });
    expect(await control({ ...removing, operationId: op(), op: 'pause' })).toMatchObject({ status: 'missing', scheduleId: s2 });
    expect([...panel().changes.values()].map((change) => change.operation)).toEqual(['disable', 'enable', 'remove']);
    // Adding or retiming is asking the assistant there, not a panel change; another change under a used id is the caller's mistake.
    await expect(control({ operationId: op(), op: 'register', prompt: 'x', cron: '0 8 * * *' })).rejects.toMatchObject({ code: 'elsewhere' });
    await expect(control({ operationId: op(), op: 'update', scheduleId: s1, revision: '1', title: 'New' })).rejects.toMatchObject({ code: 'elsewhere' });
    await expect(control({ operationId: pauseId, op: 'resume', scheduleId: s1, revision: '11' })).rejects.toMatchObject({ code: 'invalid' });
    expect(panel().changes.size).toBe(3);
    expect(rows()).toEqual([]);
  });

  it('its home offline: accepted changes stay pending, a later one supersedes, a refused one is failed and the list unavailable', async () => {
    assistantElsewhere();
    const first = op();
    const paused = await control({ operationId: first, op: 'pause', scheduleId: s1, revision: '11' });
    expect(paused).toMatchObject({ status: 'pending', revision: '13' });
    expect(await control({ operationId: first, op: 'pause', scheduleId: s1, revision: '11' })).toMatchObject({ status: 'pending' });
    // The person changes their mind before the home is back: the newer change is the one it will apply.
    const second = op();
    expect(await control({ operationId: second, op: 'resume', scheduleId: s1, revision: '13' })).toMatchObject({ status: 'pending', revision: '14' });
    expect(await control({ operationId: first, op: 'pause', scheduleId: s1, revision: '11' })).toMatchObject({ status: 'superseded' });
    panel().homeRefuses(panel().pendingOf()[0]!);
    expect(await control({ operationId: second, op: 'resume', scheduleId: s1, revision: '13' })).toMatchObject({ status: 'failed' });
    expect(await list()).toEqual({ name: 'main', state: 'unavailable' });
    await expect(control({ operationId: op(), op: 'pause', scheduleId: s2, revision: '12' })).rejects.toMatchObject({ code: 'unavailable' });
    // Applied on its next try: the failed one is applied after all.
    panel().homeApplies();
    expect(await control({ operationId: second, op: 'resume', scheduleId: s1, revision: '13' })).toMatchObject({ status: 'applied' });
    expect(await list()).toMatchObject({ state: 'ready' });
  });

  it('an answer lost on the way, or the cloud down, is unavailable; the same id again finds the one change instead of making another', async () => {
    assistantElsewhere();
    const lost = op();
    panel().loseAnswer = true;
    await expect(control({ operationId: lost, op: 'pause', scheduleId: s1, revision: '11' })).rejects.toMatchObject({ code: 'unavailable' });
    panel().loseAnswer = false;
    expect(await control({ operationId: lost, op: 'pause', scheduleId: s1, revision: '11' })).toMatchObject({ status: 'pending', scheduleId: s1, revision: '13' });
    expect(panel().changes.size).toBe(1);
    // Down before anything was sent: nothing changes, and asking again later sends it once.
    const down = op();
    panel().down = true;
    await expect(control({ operationId: down, op: 'pause', scheduleId: s2, revision: '12' })).rejects.toMatchObject({ code: 'unavailable' });
    panel().down = false;
    expect(panel().changes.size).toBe(1);
    expect(await control({ operationId: down, op: 'pause', scheduleId: s2, revision: '12' })).toMatchObject({ status: 'pending', scheduleId: s2 });
    expect(await control({ operationId: down, op: 'pause', scheduleId: s2, revision: '12' })).toMatchObject({ status: 'pending', scheduleId: s2 });
    expect(panel().changes.size).toBe(2);
    // Never arrived, and the schedule changed since: asked again, the panel refuses the stale revision — a conflict.
    const dropped = op();
    panel().dropCommit = true;
    const { revision } = await current(s1);
    await expect(control({ operationId: dropped, op: 'resume', scheduleId: s1, revision })).rejects.toMatchObject({ code: 'unavailable' });
    panel().dropCommit = false;
    panel().put(K1, { ...panel().rows.get(K1)!.data, title: 'Renamed at home' });
    expect(await control({ operationId: dropped, op: 'resume', scheduleId: s1, revision })).toMatchObject({ status: 'conflict', scheduleId: s1, revision: (await current(s1)).revision });
    expect(panel().changes.size).toBe(2);
    // Authority as everywhere: another account, a withdrawn grant — refused, nothing sent.
    (state.service as ExtensionsService).setPermissionGranted(ID, 'chat:schedules:control', false);
    await expect(control({ operationId: op(), op: 'resume', scheduleId: s2, revision: '14' })).rejects.toMatchObject({ code: 'denied' });
    (state.service as ExtensionsService).setPermissionGranted(ID, 'chat:schedules:control', true);
    state.cloud.owned = false;
    await expect(list()).rejects.toMatchObject({ code: 'denied' });
    expect(panel().changes.size).toBe(2);
  });

  it('hears the panel\'s word only when the schedules or their outstanding changes differ, an unreadable panel once, and stops for good once the grant goes', async () => {
    assistantElsewhere();
    const heard = vi.fn();
    const ended = vi.fn();
    const stop = await watchBoundSchedules(ID, { name: 'main' }, heard, ended);
    expect(state.panelWords.size).toBe(1);
    // A word with nothing of the schedules changed (another part of the panel, a resubscription) is not heard.
    panel().tell();
    await settle();
    expect(heard).not.toHaveBeenCalled();
    await control({ operationId: op(), op: 'pause', scheduleId: s1, revision: '11' });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledOnce(), wait);
    // The home refusing it changes no schedule, only where the change is: heard.
    panel().homeRefuses(panel().pendingOf()[0]!);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(2), wait);
    panel().homeApplies();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(3), wait);
    // The cloud unreachable: one word, then quiet until it answers again.
    panel().down = true;
    panel().tell();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(4), wait);
    panel().tell();
    await settle();
    expect(heard).toHaveBeenCalledTimes(4);
    panel().down = false;
    panel().tell();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(5), wait);
    (state.service as ExtensionsService).setPermissionGranted(ID, 'chat:schedules', false);
    panel().put(K2, { title: 'Bank', prompt: 'Call the bank', at: null, cron: '0 9 * * *', tz: 'Asia/Shanghai', enabled: true, nextRunAt: null, lastRun: null });
    panel().tell();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce(), wait);
    expect(heard).toHaveBeenCalledTimes(5);
    expect(state.panelWords.size).toBe(0);
    stop();
    expect(ended).toHaveBeenCalledOnce();
  });
});
