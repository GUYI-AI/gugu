import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_WORK_ITEM_FIELDS, WORK_HANDLE, type AppBindingWork, type PushedWorkRow } from '@shared/extensions/work-binding';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';

/**
 * #1925 (API 46): the work the person's own assistant handed out, for an App, through its conversation binding. Authority is
 * #1927's (this account's own selection for this installed App, `work` declared and `chat:work` granted) plus one: the chosen
 * conversation is the account's private chat with its own assistant — re-asked after every wait. The rows are the window's
 * reading (AppWorkLedgerHost); main answers them only for the account and assistant it just verified, each with a handle that
 * means nothing outside this App and this choice. The bridge door is app-work-bridge.test.ts's; the real service's grant
 * rules and the manifest are app-unread-bindings.test.ts's.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const DEVICE = '55000000-0000-4000-8000-000000000005';
const STRANGER = '66000000-0000-4000-8000-000000000006';
const WORK_A = 'a1000000-0000-4000-8000-0000000000a1';
const WORK_B = 'b2000000-0000-4000-8000-0000000000b2';
const SESSION_A = 'session-a-7f3a';
const SESSION_A2 = 'session-a-second-executor';
const SESSION_B = 'session-b-9c41';
// The stored choice's own handle (host data): long enough that no 22-character row handle contains it by chance.
const SELECTION_1 = 'selection-handle-0001';
const SELECTION_2 = 'selection-handle-0002';
const APP = 'assistant-app';
const OTHER_APP = 'other-app';

const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: '', installed: true, enabled: true, granted: true,
  declared: ['unread', 'surface', 'work'] as string[],
  provisions: [] as unknown[], provisionError: false,
  chatKind: 'dm' as string | null, members: [] as string[], chatError: false,
  reads: 0,
  afterRead: undefined as (() => void) | undefined,
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
const manifestOf = (id: string) => ({ id, permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: state.declared }] } });
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed) throw denied('not installed');
    if (!state.enabled || !state.granted || !state.declared.includes(action) || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  },
  list: () => ({ extensions: state.installed ? [{ manifest: manifestOf(APP) }, { manifest: manifestOf(OTHER_APP) }, { manifest: { id: 'plain', permissions: {} } }] : [] }),
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: ({ schema }: { schema: string }) => ({ from: (table: string) => {
  const answer = () => {
    state.reads += 1;
    state.afterRead?.();
    if (schema === 'identity') return state.provisionError ? { data: null, error: { message: 'down' } } : { data: state.provisions, error: null };
    if (state.chatError) return { data: null, error: { message: 'down' } };
    if (table === 'chats') return { data: state.chatKind ? { kind: state.chatKind } : null, error: null };
    return { data: state.members.map((user_id) => ({ user_id })), error: null };
  };
  const query: Record<string, unknown> = {
    select: () => query, eq: () => query, in: () => query,
    maybeSingle: async () => answer(),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(answer).then(resolve, reject),
  };
  return query;
} }) }));
const { appBindingWork, appBindingWorkHeard, appCloseWork, appOpenWork, appsReadingWork, forgetWorkLedgerForTest, workLedgerChanged } = await import('./app-work-binding');
const { forgetHostLayersForTest, reportHostLayer } = await import('./app-host-layers');
/** The window's word on the host page over an App's panel (app-host-layers.ts): a task (`open`), or another page, or none. */
const reportWorkChat = ({ extensionId, ownerId, open }: { extensionId: string; ownerId: string; open: { workId: string; sessionId: string; deviceId?: string } | null }) =>
  reportHostLayer({ extensionId, layer: open ? { kind: 'work', ownerId, ...open } : null });

const provision = (agent: string, removed: string | null = null) => ({
  agent_user_id: agent, device_id: DEVICE, member_key: 'assistant', phase: 'ready', created_at: '2026-11-01T00:00:00Z', agent: { removed_at: removed },
});
const row = (over: Partial<PushedWorkRow> = {}): PushedWorkRow => ({
  workId: WORK_A, sessionId: SESSION_A, title: 'Compare three flights', naming: false,
  status: { status: 'working', detail: 'running' }, unseen: false, updatedAt: '2026-11-11T08:00:00.000Z', ...over,
});
const ROWS = [
  row({ workId: WORK_B, sessionId: SESSION_B, title: 'Draft the weekly note', status: { status: 'idle', detail: 'done' }, updatedAt: '2026-11-10T09:00:00.000Z' }),
  row(),
  row({ sessionId: SESSION_A2, title: 'Compare three flights', status: null, unseen: true, updatedAt: '2026-11-11T07:00:00.000Z' }),
];
const push = (over: Record<string, unknown> = {}) => workLedgerChanged({ ownerId: OWNER, assistantId: ASSISTANT, state: 'ready', rows: ROWS, ...over });
const work = (app = APP) => appBindingWork(app, { name: 'main' });
const ready = async (app = APP) => {
  const answer = await work(app);
  if (answer.state !== 'ready') throw new Error(`not ready: ${answer.state}`);
  return answer;
};
const DOCK = { tabId: 'dock' };
const IDS = [OWNER, OTHER, CHAT, ASSISTANT, DEVICE, STRANGER, WORK_A, WORK_B, SESSION_A, SESSION_A2, SESSION_B, SELECTION_1];
const leaks = (said: unknown) => IDS.filter((id) => JSON.stringify(said).includes(id));

beforeEach(() => {
  forgetWorkLedgerForTest();
  forgetHostLayersForTest();
  Object.assign(state, {
    owner: OWNER, selectedBy: OWNER, handle: SELECTION_1, installed: true, enabled: true, granted: true, declared: ['unread', 'surface', 'work'],
    provisions: [provision(ASSISTANT)], provisionError: false, chatKind: 'dm', members: [OWNER, ASSISTANT], chatError: false,
    reads: 0, afterRead: undefined,
  });
});

/** Each way the chosen conversation is not the account's private chat with its own assistant. */
const NOT_MINE: [string, () => void][] = [
  ['no assistant of its own', () => { state.provisions = []; }],
  ['its assistant was removed', () => { state.provisions = [provision(ASSISTANT, '2026-11-02T00:00:00Z')]; }],
  ['a chat with another agent', () => { state.members = [OWNER, STRANGER]; }],
  ['a group with the assistant in it', () => { state.chatKind = 'group'; state.members = [OWNER, ASSISTANT, STRANGER]; }],
  ['a private chat of three', () => { state.members = [OWNER, ASSISTANT, STRANGER]; }],
  ['a topic', () => { state.chatKind = 'topic'; }],
  ['the account is not in it', () => { state.members = [OTHER, ASSISTANT]; }],
  ['no such chat', () => { state.chatKind = null; }],
];

describe('gugu.bindings.work: the rows as the built-in list draws them', () => {
  it('answers each row with exactly the fields the list draws, newest first, and no id of any kind', async () => {
    expect(await push()).toEqual([APP, OTHER_APP]);
    const answer = await ready();
    expect(answer).toMatchObject({ name: 'main', state: 'ready', stale: false, open: null });
    expect(answer.items.map((item) => [item.title, item.updatedAt])).toEqual([
      ['Compare three flights', '2026-11-11T08:00:00.000Z'],
      ['Compare three flights', '2026-11-11T07:00:00.000Z'],
      ['Draft the weekly note', '2026-11-10T09:00:00.000Z'],
    ]);
    expect(answer.items[0]).toMatchObject({ naming: false, status: { status: 'working', detail: 'running' }, unseen: false });
    expect(answer.items[1]).toMatchObject({ status: null, unseen: true });
    expect(answer.items[2]).toMatchObject({ status: { status: 'idle', detail: 'done' } });
    expect(Object.keys(answer).sort()).toEqual(['items', 'name', 'open', 'stale', 'state']);
    for (const item of answer.items) expect(Object.keys(item).sort()).toEqual([...APP_WORK_ITEM_FIELDS].sort());
    // Two executors of one task are two rows, told apart by their handles alone.
    expect(new Set(answer.items.map((item) => item.handle)).size).toBe(3);
    for (const item of answer.items) expect(item.handle).toMatch(WORK_HANDLE);
    expect(leaks(answer)).toEqual([]);
  });

  it('takes no reading that carries more than the rows draw: an id, a path, a URL or a message is refused whole', async () => {
    await push();
    const before = await ready();
    for (const extra of [{ deviceId: DEVICE }, { chatId: CHAT }, { agentId: STRANGER }, { path: '/Users/me/notes.md' }, { url: 'https://example.com/x' }, { content: 'the message text' }, { sourceLink: 'gugu://chat/x' }]) {
      await expect(push({ rows: [{ ...row(), ...extra }] })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(push({ deviceId: DEVICE })).rejects.toMatchObject({ code: 'invalid' });
    await expect(push({ rows: [row({ workId: 'not-a-work-id' })] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(push({ rows: [row({ status: { status: 'idle', detail: 'done', running: false } as never })] })).rejects.toMatchObject({ code: 'invalid' });
    // What was kept stands as it was.
    expect(await ready()).toEqual(before);
  });

  it('a handle is this App\'s, this choice\'s: another App, or the same App after the person chooses again, gets others', async () => {
    await push();
    const mine = (await ready()).items.map((item) => item.handle);
    const theirs = (await ready(OTHER_APP)).items.map((item) => item.handle);
    expect(theirs.filter((handle) => mine.includes(handle))).toEqual([]);
    expect((await ready()).items.map((item) => item.handle)).toEqual(mine);
    state.handle = SELECTION_2;
    expect((await ready()).items.map((item) => item.handle).filter((handle) => mine.includes(handle))).toEqual([]);
  });

  it('says stale when a refresh failed and the last rows are kept; unavailable while loading or failed with nothing', async () => {
    await push({ state: 'stale' });
    expect(await work()).toMatchObject({ state: 'ready', stale: true, items: expect.any(Array) });
    for (const pending of ['loading', 'failed', 'none'] as const) {
      await push({ state: pending, rows: [] });
      expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
    }
  });

  it('is unbound before the person chooses, and asks nothing', async () => {
    await push();
    state.selectedBy = '';
    expect(await work()).toEqual({ name: 'main', state: 'unbound' });
    expect(state.reads).toBe(0);
  });

  it('is unavailable when the window read no rows, or another account\'s or another assistant\'s, or nothing can be verified now', async () => {
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
    await push({ assistantId: STRANGER });
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
    await push();
    state.provisionError = true;
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
    state.provisionError = false;
    state.chatError = true;
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
    state.chatError = false;
    // The rows stay this account's: signed in as another (who chose too), they are not that account's to read.
    state.owner = OTHER;
    state.selectedBy = OTHER;
    state.members = [OTHER, ASSISTANT];
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
  });

  it.each(NOT_MINE)('refuses when the conversation is not the account\'s chat with its own assistant: %s', async (_case, set) => {
    await push();
    set();
    await expect(work()).rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses without the grant, the action, when disabled, uninstalled or signed out', async () => {
    await push();
    for (const set of [
      () => { state.granted = false; }, () => { state.declared = ['unread', 'surface']; }, () => { state.enabled = false; },
      () => { state.installed = false; }, () => { state.owner = ''; },
    ]) {
      Object.assign(state, { owner: OWNER, installed: true, enabled: true, granted: true, declared: ['unread', 'surface', 'work'] });
      set();
      await expect(work()).rejects.toMatchObject({ code: 'denied' });
    }
  });

  it('refuses when the account, the grant, the switch, the installation or the choice changes during the check', async () => {
    await push();
    for (const change of [
      () => { state.owner = OTHER; }, () => { state.owner = ''; }, () => { state.granted = false; }, () => { state.enabled = false; },
      () => { state.installed = false; }, () => { state.handle = SELECTION_2; }, () => { state.selectedBy = ''; },
    ]) {
      Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: SELECTION_1, installed: true, enabled: true, granted: true });
      state.afterRead = change;
      await expect(work()).rejects.toMatchObject({ code: 'denied' });
      state.afterRead = undefined;
    }
  });

  it('takes the binding\'s name alone: never a chat, account, task or handle', async () => {
    await push();
    for (const extra of [{ chat: CHAT }, { chatId: CHAT }, { ownerId: OWNER }, { workId: WORK_A }, { sessionId: SESSION_A }, { assistant: ASSISTANT }]) {
      await expect(appBindingWork(APP, { name: 'main', ...extra })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appBindingWork(APP, { name: 'other' })).rejects.toMatchObject({ code: 'denied' });
    await expect(appBindingWork(APP, { name: 7 })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('what onWorkChanged hears is the same answer; a refusal is heard as unavailable, never why', async () => {
    await push();
    expect(await appBindingWorkHeard(APP, 'main')).toEqual(await work());
    state.members = [OWNER, STRANGER];
    expect(await appBindingWorkHeard(APP, 'main')).toEqual({ name: 'main', state: 'unavailable', open: null });
    state.members = [OWNER, ASSISTANT];
    state.granted = false;
    expect(await appBindingWorkHeard(APP, 'main')).toEqual({ name: 'main', state: 'unavailable', open: null });
  });
});

describe('the window\'s readings', () => {
  it('kept only as the signed-in account\'s, only the newest, each change told to the Apps that read work', async () => {
    expect(appsReadingWork()).toEqual([APP, OTHER_APP]);
    expect(await push()).toEqual([APP, OTHER_APP]);
    // The same reading again: nobody to tell.
    expect(await push()).toEqual([]);
    await expect(push({ ownerId: OTHER })).rejects.toMatchObject({ code: 'denied' });
    state.owner = '';
    await expect(push()).rejects.toMatchObject({ code: 'denied' });
    state.owner = OWNER;
    // Two readings in flight: the later one stands, whichever resolves last.
    const [older, newer] = [push({ rows: [row()] }), push({ rows: ROWS.slice(0, 1) })];
    expect(await older).toEqual([]);
    expect(await newer).toEqual([APP, OTHER_APP]);
    expect((await ready()).items.map((item) => item.title)).toEqual(['Draft the weekly note']);
    // None: there is nothing to read until the window reads again.
    expect(await workLedgerChanged({ ownerId: null, assistantId: null, state: 'none', rows: [] })).toEqual([APP, OTHER_APP]);
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: null });
  });

  it('wherever the assistant lives — this computer, another, a server, the cloud — the rows are the same account ledger', async () => {
    // The ledger is the account's (assistant-work-records.ts): executors on other machines, offline or not, are rows as any.
    const elsewhere = ROWS.map((candidate, index) => ({ ...candidate, sessionId: `${candidate.sessionId}-on-device-${index}` }));
    await push({ rows: elsewhere });
    const answer = await ready();
    expect(answer.items).toHaveLength(3);
    expect(leaks(answer)).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain('on-device');
  });
});

describe('gugu.bindings.openWork / closeWork: one task drawn in the App\'s panel', () => {
  const act = vi.fn<(action: ExtensionHostAction) => Promise<unknown>>(async () => undefined);
  beforeEach(() => act.mockClear());

  it('asks the window to draw the row the handle names, with the account checked, from the App\'s own page', async () => {
    await push();
    const [newest, second] = (await ready()).items;
    await appOpenWork(APP, DOCK, { name: 'main', handle: newest!.handle }, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openWork', ownerId: OWNER, workId: WORK_A, sessionId: SESSION_A });
    await appOpenWork(APP, DOCK, { name: 'main', handle: second!.handle }, act);
    expect(act).toHaveBeenLastCalledWith({ kind: 'openWork', ownerId: OWNER, workId: WORK_A, sessionId: SESSION_A2 });
  });

  it('refuses a handle of another App, of a choice made before, of a row gone, or one that is not a handle', async () => {
    await push();
    const handle = (await ready()).items[0]!.handle;
    const theirs = (await ready(OTHER_APP)).items[0]!.handle;
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle: theirs }, act)).rejects.toMatchObject({ code: 'not-found' });
    await push({ rows: ROWS.slice(0, 1) });
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'not-found' });
    await push();
    state.handle = SELECTION_2;
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'not-found' });
    for (const bad of [WORK_A, SESSION_A, 'w', `${handle}x`, 7, null]) {
      await expect(appOpenWork(APP, DOCK, { name: 'main', handle: bad }, act)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle, workId: WORK_A }, act)).rejects.toMatchObject({ code: 'invalid' });
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses from a page not drawn as the App\'s own, unbound, unreadable, not the assistant\'s chat, or changed mid-check', async () => {
    await push();
    const handle = (await ready()).items[0]!.handle;
    await expect(appOpenWork(APP, { tabId: 'session-tab-7' }, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'denied' });
    state.selectedBy = '';
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    await push({ state: 'loading', rows: [] });
    await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'failed' });
    await push();
    for (const [, set] of NOT_MINE) {
      Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
      set();
      await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
    for (const change of [() => { state.owner = OTHER; }, () => { state.granted = false; }, () => { state.installed = false; }, () => { state.enabled = false; }, () => { state.handle = SELECTION_2; }]) {
      Object.assign(state, { owner: OWNER, handle: SELECTION_1, installed: true, enabled: true, granted: true });
      state.afterRead = change;
      await expect(appOpenWork(APP, DOCK, { name: 'main', handle }, act)).rejects.toMatchObject({ code: 'denied' });
      state.afterRead = undefined;
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('closeWork asks the window to take it away, with the grant; never without it', async () => {
    await appCloseWork(APP, { name: 'main' }, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'closeWork' });
    act.mockClear();
    for (const set of [() => { state.granted = false; }, () => { state.installed = false; }, () => { state.owner = ''; }]) {
      Object.assign(state, { owner: OWNER, installed: true, granted: true });
      set();
      await expect(appCloseWork(APP, { name: 'main' }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    await expect(appCloseWork(APP, { name: 'main', handle: 'x' }, act)).rejects.toMatchObject({ code: 'invalid' });
    expect(act).not.toHaveBeenCalled();
  });

  it('open is the drawn row\'s handle for this App alone, gone when the window takes it away or another account signs in', async () => {
    await push();
    const handle = (await ready()).items[0]!.handle;
    expect(reportWorkChat({ extensionId: APP, ownerId: OWNER, open: { workId: WORK_A, sessionId: SESSION_A } })).toBe(true);
    expect((await ready()).open).toBe(handle);
    // The same report again changes nothing anyone hears; another App's panel shows nothing.
    expect(reportWorkChat({ extensionId: APP, ownerId: OWNER, open: { workId: WORK_A, sessionId: SESSION_A } })).toBe(false);
    expect((await ready(OTHER_APP)).open).toBeNull();
    // Unreadable meanwhile: still said open, so the App keeps its list hidden.
    await push({ state: 'loading', rows: [] });
    expect(await work()).toEqual({ name: 'main', state: 'unavailable', open: handle });
    await push();
    expect(reportWorkChat({ extensionId: APP, ownerId: OWNER, open: null })).toBe(true);
    expect((await ready()).open).toBeNull();
    expect(reportWorkChat({ extensionId: APP, ownerId: OWNER, open: null })).toBe(false);
    // A report of another account's task is never this account's open row: the window took it away on the switch.
    reportWorkChat({ extensionId: APP, ownerId: OTHER, open: { workId: WORK_A, sessionId: SESSION_A } });
    expect((await ready()).open).toBeNull();
    // Another host page over the panel (the assistant's settings) is no row of the App's.
    expect(reportHostLayer({ extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OWNER } })).toBe(true);
    expect((await ready()).open).toBeNull();
    expect(() => reportWorkChat({ extensionId: APP, ownerId: OWNER, open: { workId: WORK_A, sessionId: SESSION_A, deviceId: DEVICE } })).toThrow();
    expect(() => reportHostLayer({ extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OWNER, chatId: CHAT } })).toThrow();
    expect(() => reportHostLayer({ extensionId: APP, layer: { kind: 'somewhere', ownerId: OWNER } })).toThrow();
  });

  it('every answer of a ready App is free of ids, open or not', async () => {
    await push();
    reportWorkChat({ extensionId: APP, ownerId: OWNER, open: { workId: WORK_A, sessionId: SESSION_A } });
    const answers: AppBindingWork[] = [await work(), await appBindingWorkHeard(APP, 'main')];
    for (const answer of answers) expect(leaks(answer)).toEqual([]);
  });
});
