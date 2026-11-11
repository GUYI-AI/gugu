import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_SCREENS, type ShownAssistant } from '@shared/extensions/assistant-binding';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';

/**
 * #1925 (API 44): an App's word about the person's own assistant, through its conversation binding. Authority is #1927's
 * (this account's own selection for this installed App, the action declared and granted) plus one: the chosen conversation
 * is the account's private chat with its own assistant — re-asked after every wait. The App hears no chat, device or
 * account id. The real service's grant rules are in app-assistant-grants.test.ts; the bridge door in app-assistant-bridge.test.ts.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const DEVICE = '55000000-0000-4000-8000-000000000005';
const STRANGER = '66000000-0000-4000-8000-000000000006';
const APP = 'assistant-app';

const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true,
  grants: {} as Record<string, boolean>,
  declared: ['unread', 'assistant-status', 'assistant-open'] as string[],
  provisions: [] as unknown[], provisionError: false,
  chatKind: 'dm' as string | null, members: [] as string[], chatError: false,
  reads: 0,
  afterRead: undefined as (() => void) | undefined,
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.grants[action] || !state.declared.includes(action) || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  },
  list: () => ({ extensions: state.installed ? [{ manifest: { id: APP, permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: state.declared }] } } }] : [] }),
  isEnabled: () => state.enabled,
  isInstalled: (app: string) => state.installed && app === APP,
  hasCapability: (_app: string, capability: string) => state.grants[`assistant-${capability.slice('assistant:'.length)}`] === true,
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
const binding = await import('./app-assistant-binding');
const { appAssistantStatus, appAssistantOpen, appAssistantAdvanceSetup, appAssistantRename, appAssistantFigure, appAssistantConnect, assistantStatusChanged, assistantCountsChanged, appHostLayerChanged, forgetShownAssistantForTest } = binding;

const provision = (agent: string, removed: string | null = null) => ({
  agent_user_id: agent, device_id: DEVICE, member_key: 'assistant', phase: 'ready', created_at: '2026-11-01T00:00:00Z', agent: { removed_at: removed },
});
const status = (over: Partial<ShownAssistant> = {}): ShownAssistant => ({
  assistant: 'found', name: 'Dot', avatar: 'data:image/webp;base64,UklGRg==', tint: 83.3, home: { kind: 'this-computer', online: true, label: 'Studio Mac' },
  setup: 'connect', preparing: false, cloudAvailable: true, member: null, loadError: null, ownerName: 'Ann', ...over,
});
/** As an App reads the window's snapshot: with the panel's numbers and the connect list (none pushed: null), and the name limit. */
const seen = (value: ShownAssistant, counts: unknown = null, connectors: unknown = null) => ({ ...value, counts, connectors, nameMax: 30 });
const hear = vi.fn();
const show = (value = status(), ownerId = OWNER) => assistantStatusChanged({ ownerId, status: value }, hear);
const IDS = [OWNER, OTHER, CHAT, ASSISTANT, DEVICE, STRANGER, 'h1'];
const leaks = (said: unknown) => IDS.filter((id) => JSON.stringify(said).includes(id));

beforeEach(() => {
  forgetShownAssistantForTest();
  Object.assign(state, {
    owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true,
    grants: { 'assistant-status': true, 'assistant-open': true, 'assistant-rename': true }, declared: ['unread', 'assistant-status', 'assistant-open', 'assistant-rename'],
    provisions: [provision(ASSISTANT)], provisionError: false, chatKind: 'dm', members: [OWNER, ASSISTANT], chatError: false,
    reads: 0, afterRead: undefined,
  });
  hear.mockReset();
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

describe('gugu.assistant.status: the snapshot of the person\'s own assistant', () => {
  it('answers the snapshot the window showed — and no chat, device, account id or binding handle', async () => {
    await show();
    const read = await appAssistantStatus(APP, { name: 'main' });
    expect(read).toEqual({ name: 'main', state: 'ready', status: seen(status()), hostPage: false });
    expect(leaks(read)).toEqual([]);
    // Exactly the fields the built-in view holds and an App needs to pick what to draw.
    expect(Object.keys((read as { status: object }).status).sort()).toEqual(['assistant', 'avatar', 'cloudAvailable', 'connectors', 'counts', 'home', 'loadError', 'member', 'name', 'nameMax', 'ownerName', 'preparing', 'setup', 'tint']);
  });

  it('passes unreadable apart from none, and an unknown membership as null, never false', async () => {
    await show(status({ assistant: 'unreadable', name: null, avatar: null, home: null, member: null }));
    expect(await appAssistantStatus(APP, { name: 'main' })).toMatchObject({ state: 'ready', status: { assistant: 'unreadable', member: null } });
    await show(status({ assistant: 'none', name: null, avatar: null, home: null, member: false }));
    expect(await appAssistantStatus(APP, { name: 'main' })).toMatchObject({ state: 'ready', status: { assistant: 'none', member: false } });
  });

  it('is unbound before the person chooses, and asks nothing', async () => {
    state.selectedBy = '';
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' });
    expect(state.reads).toBe(0);
  });

  it('is unavailable when it cannot be verified now, or the window has not shown this account\'s assistant', async () => {
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
    await show(status(), OTHER);
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
    await show();
    state.provisionError = true;
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
    state.provisionError = false;
    state.chatError = true;
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
  });

  it.each(NOT_MINE)('refuses when the conversation is not the account\'s chat with its own assistant: %s', async (_case, set) => {
    await show();
    set();
    await expect(appAssistantStatus(APP, { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses without the grant, disabled or uninstalled — and when any of it changes, or the account does, mid-request', async () => {
    await show();
    for (const set of [() => { state.grants['assistant-status'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.declared = ['unread', 'assistant-open']; }]) {
      set();
      await expect(appAssistantStatus(APP, { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
      Object.assign(state, { installed: true, enabled: true, grants: { 'assistant-status': true, 'assistant-open': true }, declared: ['unread', 'assistant-status', 'assistant-open'] });
    }
    for (const change of [() => { state.grants['assistant-status'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.handle = 'h2'; }, () => { state.owner = OTHER; }, () => { state.owner = ''; }]) {
      Object.assign(state, { owner: OWNER, handle: 'h1', installed: true, enabled: true, grants: { 'assistant-status': true, 'assistant-open': true } });
      state.afterRead = change;
      await expect(appAssistantStatus(APP, { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    }
  });

  it('another account\'s selection reaches nothing', async () => {
    await show(status(), OTHER);
    state.owner = OTHER;
    state.reads = 0;
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' });
    expect(state.reads).toBe(0);
  });

  it('takes the binding\'s name alone: a chat, owner, handle or device given is refused before anything is asked', async () => {
    for (const extra of [{ chat: CHAT }, { chatId: CHAT }, { ownerId: OWNER }, { handle: 'h1' }, { device: DEVICE }, { agent: ASSISTANT }]) {
      await expect(appAssistantStatus(APP, { name: 'main', ...extra })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appAssistantStatus(APP, { name: 'other' })).rejects.toMatchObject({ code: 'denied' });
    expect(state.reads).toBe(0);
  });
});

describe('gugu.assistant.open: one of the host\'s own screens, from a closed list', () => {
  it.each(ASSISTANT_SCREENS.filter((screen) => screen !== 'health'))('%s: the window is asked to open exactly that screen, for the account checked', async (screen) => {
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    expect(await appAssistantOpen(APP, { name: 'main', screen }, act)).toBeUndefined();
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openAssistantScreen', screen, ownerId: OWNER });
  });

  it('health (49) is a phone\'s page: a computer answers the closed unsupported state once the binding is checked, and opens nothing', async () => {
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    expect(await appAssistantOpen(APP, { name: 'main', screen: 'health' }, act)).toEqual({ name: 'main', state: 'unsupported' });
    expect(act).not.toHaveBeenCalled();
    await expect(appAssistantOpen(APP, { name: 'other', screen: 'health' }, act)).rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses any other value, or anything more than the value, before anything is asked', async () => {
    const act = vi.fn(async () => undefined);
    for (const args of [
      { name: 'main', screen: 'memory' }, { name: 'main', screen: 'Setup' }, { name: 'main', screen: '' }, { name: 'main', screen: 'close ' },
      { name: 'main', screen: ['close'] }, { name: 'main', screen: { kind: 'close' } }, { name: 'main' }, { screen: 'close' },
      { name: 'main', screen: 'model', model: 'opus' }, { name: 'main', screen: 'move', to: 'cloud' }, { name: 'main', screen: 'close', chatId: CHAT },
    ]) await expect(appAssistantOpen(APP, args, act)).rejects.toMatchObject({ code: 'invalid' });
    expect(act).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
  });

  it.each(NOT_MINE)('refuses, and opens nothing, when the conversation is not the account\'s chat with its own assistant: %s', async (_case, set) => {
    const act = vi.fn(async () => undefined);
    set();
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'close' }, act)).rejects.toMatchObject({ code: 'denied' });
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses unbound, without its own grant (status alone is not enough), on an account switch or a withdrawal mid-request', async () => {
    const act = vi.fn(async () => undefined);
    state.selectedBy = '';
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'move' }, act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    state.grants = { 'assistant-status': true };
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'move' }, act)).rejects.toMatchObject({ code: 'denied' });
    for (const change of [() => { state.owner = OTHER; }, () => { state.grants['assistant-open'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, { owner: OWNER, handle: 'h1', installed: true, enabled: true, grants: { 'assistant-status': true, 'assistant-open': true } });
      state.afterRead = change;
      await expect(appAssistantOpen(APP, { name: 'main', screen: 'close' }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('a check that could not be made is a failure, and nothing opens', async () => {
    const act = vi.fn(async () => undefined);
    state.provisionError = true;
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'look' }, act)).rejects.toMatchObject({ code: 'failed' });
    expect(act).not.toHaveBeenCalled();
  });
});

describe('gugu.assistant.advanceSetup: the steps the App draws, connect → ready → done', () => {
  it.each([['connect', 'ready'], ['connect', 'done'], ['ready', 'done']] as const)('from %s to %s', async (from, next) => {
    await show(status({ setup: from }));
    const act = vi.fn(async () => undefined);
    await appAssistantAdvanceSetup(APP, { name: 'main', next }, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'advanceAssistantSetup', next, ownerId: OWNER });
  });

  it.each([
    ['shell', 'ready'], ['shell', 'done'], [null, 'ready'], [null, 'done'], ['ready', 'ready'],
  ] as const)('refuses from %s to %s, the host\'s part and outside setup included', async (from, next) => {
    await show(status({ setup: from }));
    const act = vi.fn(async () => undefined);
    await expect(appAssistantAdvanceSetup(APP, { name: 'main', next }, act)).rejects.toMatchObject({ code: 'invalid' });
    expect(act).not.toHaveBeenCalled();
  });

  it('takes only "ready" or "done": no step back, no shell, nothing else', async () => {
    await show(status({ setup: 'connect' }));
    const act = vi.fn(async () => undefined);
    for (const next of ['connect', 'shell', null, '', 'Ready', undefined, 1]) {
      await expect(appAssistantAdvanceSetup(APP, { name: 'main', next }, act)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses for another\'s assistant, and fails while the window has not shown the step', async () => {
    const act = vi.fn(async () => undefined);
    await expect(appAssistantAdvanceSetup(APP, { name: 'main', next: 'ready' }, act)).rejects.toMatchObject({ code: 'failed' });
    await show(status({ setup: 'connect' }));
    state.members = [OWNER, STRANGER];
    await expect(appAssistantAdvanceSetup(APP, { name: 'main', next: 'ready' }, act)).rejects.toMatchObject({ code: 'denied' });
    expect(act).not.toHaveBeenCalled();
  });
});

describe('gugu.assistant.onChanged: each new snapshot, to an App still entitled to it', () => {
  it('tells a granted App the new snapshot as status answers it, once per change, with no id', async () => {
    await show();
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: seen(status()), hostPage: false });
    expect(leaks(hear.mock.calls)).toEqual([]);
    await show();
    expect(hear).toHaveBeenCalledOnce();
    await show(status({ setup: 'ready' }));
    expect(hear).toHaveBeenCalledTimes(2);
  });

  it('stops after the grant is withdrawn, the App is disabled or uninstalled, or its conversation is not the assistant\'s', async () => {
    let n = 0;
    const next = () => status({ name: `Dot ${n += 1}` });
    for (const set of [
      () => { state.grants['assistant-status'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; },
      () => { state.declared = ['unread', 'assistant-open']; }, () => { state.members = [OWNER, STRANGER]; }, () => { state.selectedBy = ''; },
    ]) {
      Object.assign(state, { installed: true, enabled: true, selectedBy: OWNER, members: [OWNER, ASSISTANT], grants: { 'assistant-status': true, 'assistant-open': true }, declared: ['unread', 'assistant-status', 'assistant-open'] });
      await show(next());
      expect(hear).toHaveBeenCalledOnce();
      hear.mockReset();
      set();
      await show(next());
      expect(hear).not.toHaveBeenCalled();
    }
  });

  it('a withdrawal while it is being checked: not told', async () => {
    state.afterRead = () => { state.grants['assistant-status'] = false; };
    await show();
    expect(hear).not.toHaveBeenCalled();
  });

  it('takes from the window only what an App may see: an id, a path or a storage address is refused, and nothing is kept or told', async () => {
    for (const bad of [
      { ...status(), chatId: CHAT },
      { ...status(), avatar: `https://storage.example/avatars/${ASSISTANT}.png` },
      { ...status(), avatar: `file:///Users/me/${ASSISTANT}.png` },
      { ...status(), home: { kind: 'this-computer', online: true, deviceId: DEVICE } },
      { ...status(), loadError: `failed ${DEVICE}` },
      { ...status(), assistant: 'missing' },
      { ...status(), member: 'unknown' },
    ]) await expect(assistantStatusChanged({ ownerId: OWNER, status: bad }, hear)).rejects.toMatchObject({ code: 'invalid' });
    await expect(assistantStatusChanged({ ownerId: 'me', status: status() }, hear)).rejects.toMatchObject({ code: 'invalid' });
    expect(hear).not.toHaveBeenCalled();
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
  });
});

describe('an account with no assistant: the first setup can start from the App', () => {
  const NO_ASSISTANT = ['none', 'loading', 'unreadable'] as const;
  // What the window would never send for these states, sent anyway: main still keeps it from the App.
  const without = (assistant: (typeof NO_ASSISTANT)[number], over: Partial<ShownAssistant> = {}) =>
    status({ assistant, setup: assistant === 'none' ? 'shell' : null, preparing: false, member: false, ...over });
  const stripped = (value: ShownAssistant) => ({ ...value, name: null, avatar: null, tint: null, home: null, counts: null, connectors: null, nameMax: 30 });

  it.each(NO_ASSISTANT)('%s, no conversation chosen: status is the snapshot without one — no name, look or home, nothing asked', async (assistant) => {
    state.selectedBy = '';
    state.provisions = [];
    await show(without(assistant));
    state.reads = 0;
    const read = await appAssistantStatus(APP, { name: 'main' });
    expect(read).toEqual({ name: 'main', state: 'ready', status: stripped(without(assistant)), hostPage: false });
    expect(leaks(read)).toEqual([]);
    expect(state.reads).toBe(0);
  });

  it('the assistant gone while the bound chat is being checked: the snapshot without one, never its name, look or home', async () => {
    await show(status());
    const gone = without('none', { name: 'Dot', avatar: status().avatar, home: status().home });
    state.afterRead = () => {
      state.afterRead = undefined;
      void assistantStatusChanged({ ownerId: OWNER, status: gone }, () => {});
    };
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'ready', status: stripped(gone), hostPage: false });
  });

  it('has an assistant and no conversation chosen: still unbound, nothing of it', async () => {
    state.selectedBy = '';
    await show(status());
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' });
  });

  it('a conversation chosen before (its assistant since closed): the snapshot without one, not refused', async () => {
    await show(without('none'));
    for (const [, set] of NOT_MINE) {
      set();
      expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'ready', status: stripped(without('none')), hostPage: false });
    }
  });

  it('still needs the grant, the App enabled and installed and the action declared; another account\'s window tells nothing', async () => {
    state.selectedBy = '';
    await show(without('none'));
    for (const set of [() => { state.grants['assistant-status'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.declared = ['unread', 'assistant-open']; }]) {
      Object.assign(state, { installed: true, enabled: true, grants: { 'assistant-status': true, 'assistant-open': true }, declared: ['unread', 'assistant-status', 'assistant-open'] });
      set();
      await expect(appAssistantStatus(APP, { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { installed: true, enabled: true, grants: { 'assistant-status': true, 'assistant-open': true }, declared: ['unread', 'assistant-status', 'assistant-open'] });
    state.owner = OTHER;
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' });
  });

  it.each(NO_ASSISTANT)('%s: open("setup") opens setup with no conversation chosen; it needs its own grant', async (assistant) => {
    state.selectedBy = '';
    await show(without(assistant));
    state.reads = 0;
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await appAssistantOpen(APP, { name: 'main', screen: 'setup' }, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openAssistantScreen', screen: 'setup', ownerId: OWNER });
    expect(state.reads).toBe(0);
    state.grants = { 'assistant-status': true };
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'setup' }, act)).rejects.toMatchObject({ code: 'denied' });
    expect(act).toHaveBeenCalledOnce();
  });

  it('every other screen, and advanceSetup, still need the bound assistant chat', async () => {
    state.selectedBy = '';
    await show(without('none'));
    const act = vi.fn(async () => undefined);
    for (const screen of ASSISTANT_SCREENS.filter((screen) => screen !== 'setup')) {
      await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(appAssistantAdvanceSetup(APP, { name: 'main', next: 'ready' }, act)).rejects.toMatchObject({ code: 'not-found' });
    expect(act).not.toHaveBeenCalled();
  });

  it('has an assistant and no conversation chosen: open("setup") is refused too', async () => {
    state.selectedBy = '';
    await show(status());
    const act = vi.fn(async () => undefined);
    await expect(appAssistantOpen(APP, { name: 'main', screen: 'setup' }, act)).rejects.toMatchObject({ code: 'not-found' });
    expect(act).not.toHaveBeenCalled();
  });

  it('onChanged follows none → preparing → found, then says unbound once and nothing of the assistant after', async () => {
    state.selectedBy = '';
    state.provisions = [];
    await show(without('none'));
    await show(without('none', { preparing: true }));
    await show(without('loading', { preparing: true }));
    state.provisions = [provision(ASSISTANT)];
    await show(status());
    await show(status({ name: 'Renamed', setup: 'ready' }));
    expect(hear.mock.calls).toEqual([
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('none')), hostPage: false }],
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('none', { preparing: true })), hostPage: false }],
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('loading', { preparing: true })), hostPage: false }],
      [APP, { type: 'assistantChanged', name: 'main', state: 'unbound' }],
    ]);
    expect(leaks(hear.mock.calls)).toEqual([]);
  });

  it('an App not pointed at an existing assistant hears none of its changes', async () => {
    state.selectedBy = '';
    await show(status());
    await show(status({ name: 'Renamed' }));
    await show(status({ setup: 'ready' }));
    expect(hear).not.toHaveBeenCalled();
  });

  it('once the person chooses the assistant chat, the App hears it as before', async () => {
    state.selectedBy = '';
    await show(without('none'));
    await show(status());
    hear.mockReset();
    state.selectedBy = OWNER;
    await show(status({ setup: 'ready' }));
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: seen(status({ setup: 'ready' })), hostPage: false });
  });
});

describe('counts and the connect list: what the panel and the connect step read, with the bound assistant\'s snapshot', () => {
  const ready = <T,>(value: T) => ({ state: 'ready' as const, value });
  const COUNTS = { devices: ready(3), connectedApps: ready({ saved: 4, connected: 2 }), projects: ready(7), capabilities: ready(5) };
  const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';
  const CONNECTORS = ready([
    { id: 'feishu', name: 'Feishu', icon: { light: ICON, dark: null, invertInDark: false }, connected: true },
    { id: 'github', name: 'GitHub', icon: null, connected: false },
  ]);
  const push = (counts: unknown = COUNTS, connectors: unknown = CONNECTORS, ownerId = OWNER) => assistantCountsChanged({ ownerId, counts, connectors }, hear);
  const read = () => appAssistantStatus(APP, { name: 'main' });

  it('the bound App reads them and hears them change — numbers, names and marks only', async () => {
    await show();
    hear.mockReset();
    await push();
    expect(await read()).toEqual({ name: 'main', state: 'ready', status: seen(status(), COUNTS, CONNECTORS), hostPage: false });
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: seen(status(), COUNTS, CONNECTORS), hostPage: false });
    await push();
    expect(hear).toHaveBeenCalledOnce();
    await push(COUNTS, ready([{ ...CONNECTORS.value[1]!, connected: true }]));
    expect(hear).toHaveBeenCalledTimes(2);
    expect(leaks(hear.mock.calls)).toEqual([]);
  });

  it('each says how its read is: ready with it, loading, or unreadable — never 0 for those', async () => {
    await show();
    const partly = { devices: { state: 'loading' }, connectedApps: { state: 'unreadable' }, projects: ready(0), capabilities: { state: 'unreadable' } };
    await push(partly, { state: 'loading' });
    expect(await read()).toMatchObject({ status: { counts: partly, connectors: { state: 'loading' } } });
  });

  it('another account\'s reach nothing; the snapshot without an assistant has none, and says the name limit all the same', async () => {
    await show();
    await push(COUNTS, CONNECTORS, OTHER);
    expect(await read()).toMatchObject({ status: { counts: null, connectors: null, nameMax: 30 } });
    await push();
    state.selectedBy = '';
    await show(status({ assistant: 'none', name: null, avatar: null, tint: null, home: null }));
    expect(await read()).toMatchObject({ state: 'ready', status: { assistant: 'none', counts: null, connectors: null, nameMax: 30, ownerName: 'Ann' } });
  });

  it('an App not pointed at the assistant hears nothing of them', async () => {
    state.selectedBy = '';
    await show();
    hear.mockReset();
    await push();
    expect(hear).not.toHaveBeenCalled();
  });

  it('takes read states of numbers alone: an id, a path, a URL, a name, a negative, a fraction, a bare number or another field is refused, nothing kept', async () => {
    await show();
    for (const bad of [
      { ...COUNTS, devices: ready(DEVICE) }, { ...COUNTS, projects: ready('/Users/me/project') }, { ...COUNTS, capabilities: ready('https://example.com/x') },
      { ...COUNTS, connectedApps: ready({ saved: 1, connected: 1, names: ['Mail'] }) }, { ...COUNTS, projects: ready(['Docs']) },
      { ...COUNTS, devices: ready(-1) }, { ...COUNTS, projects: ready(1.5) }, { ...COUNTS, chatId: CHAT }, { devices: ready(1) },
      { ...COUNTS, devices: 3 }, { ...COUNTS, devices: null }, { ...COUNTS, devices: { state: 'loading', value: 3 } }, { ...COUNTS, devices: { state: 'failed' } },
    ]) await expect(push(bad)).rejects.toMatchObject({ code: 'invalid' });
    await expect(assistantCountsChanged({ ownerId: 'me', counts: COUNTS, connectors: CONNECTORS }, hear)).rejects.toMatchObject({ code: 'invalid' });
    expect(await read()).toMatchObject({ status: { counts: null, connectors: null } });
  });

  it('a connect row carries no account, address or link: anything but the service, its name, its mark and connected is refused', async () => {
    await show();
    const row = CONNECTORS.value[0]!;
    for (const bad of [
      { ...row, account: 'me@example.com' }, { ...row, displayName: 'Ann Lee' }, { ...row, id: '../etc' }, { ...row, id: CHAT + ' x' },
      { ...row, icon: { ...row.icon, light: 'https://example.com/icon.svg' } }, { ...row, icon: { ...row.icon, light: 'data:text/html;base64,PGI+' } },
      { ...row, name: '' }, { ...row, connected: 'yes' },
    ]) await expect(push(COUNTS, ready([bad]))).rejects.toMatchObject({ code: 'invalid' });
    expect(await read()).toMatchObject({ status: { connectors: null } });
  });
});

describe('gugu.assistant.connect: the connect step\'s click, the window\'s own connect dialog', () => {
  const ready = <T,>(value: T) => ({ state: 'ready' as const, value });
  const COUNTS = { devices: ready(1), connectedApps: ready({ saved: 0, connected: 0 }), projects: ready(0), capabilities: ready(0) };
  const LIST = ready([{ id: 'feishu', name: 'Feishu', icon: null, connected: false }]);
  const connect = (id: unknown, act = vi.fn(async (_action: ExtensionHostAction) => undefined)) => appAssistantConnect(APP, { name: 'main', id }, act);

  it('a service of the list status shows: handed to the window for the account checked', async () => {
    await show();
    await assistantCountsChanged({ ownerId: OWNER, counts: COUNTS, connectors: LIST }, hear);
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await connect('feishu', act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openAssistantConnector', id: 'feishu', ownerId: OWNER });
  });

  it('one not in the list: not-found; the list not read yet, or not ready: failed — nothing opened', async () => {
    const act = vi.fn(async () => undefined);
    await show();
    await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'failed' });
    await assistantCountsChanged({ ownerId: OWNER, counts: COUNTS, connectors: { state: 'unreadable' } }, hear);
    await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'failed' });
    await assistantCountsChanged({ ownerId: OWNER, counts: COUNTS, connectors: LIST }, hear);
    await expect(connect('github', act)).rejects.toMatchObject({ code: 'not-found' });
    await assistantCountsChanged({ ownerId: OTHER, counts: COUNTS, connectors: LIST }, hear);
    await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'failed' });
    expect(act).not.toHaveBeenCalled();
  });

  it('refused unbound, not the assistant chat, without assistant:open (status is not it), disabled, or changed mid-request', async () => {
    const act = vi.fn(async () => undefined);
    await show();
    await assistantCountsChanged({ ownerId: OWNER, counts: COUNTS, connectors: LIST }, hear);
    state.selectedBy = '';
    await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    for (const [, set] of NOT_MINE) {
      Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
      set();
      await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
    const all = () => ({ enabled: true, installed: true, grants: { 'assistant-status': true, 'assistant-open': true, 'assistant-rename': true }, declared: ['unread', 'assistant-status', 'assistant-open', 'assistant-rename'] });
    for (const set of [() => { state.grants['assistant-open'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }]) {
      Object.assign(state, all());
      set();
      await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'denied' });
    }
    for (const change of [() => { state.owner = OTHER; }, () => { state.grants['assistant-open'] = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, all(), { owner: OWNER, handle: 'h1' });
      state.afterRead = change;
      await expect(connect('feishu', act)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('takes the binding\'s name and an id: anything more, or else, is refused before anything is asked', async () => {
    const act = vi.fn(async () => undefined);
    for (const args of [{ name: 'main' }, { name: 'main', id: 3 }, { name: 'main', id: 'x'.repeat(101) }, { name: 'main', id: 'feishu', ownerId: OWNER }]) {
      await expect(appAssistantConnect(APP, args, act)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(state.reads).toBe(0);
    expect(act).not.toHaveBeenCalled();
  });
});

describe('the panel\'s own pages over the App\'s panel: settings, projects, capabilities', () => {
  const LAYERS = ['settings', 'projects', 'capabilities'] as const;

  it.each(LAYERS)('%s: the window is asked to draw it, for the account checked', async (screen) => {
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await appAssistantOpen(APP, { name: 'main', screen }, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openAssistantScreen', screen, ownerId: OWNER });
  });

  it.each(LAYERS)('%s: refused unbound, with no assistant, not the assistant chat, without its grant, disabled, or changed mid-request', async (screen) => {
    const act = vi.fn(async () => undefined);
    state.selectedBy = '';
    await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'not-found' });
    await show(status({ assistant: 'none', name: null, avatar: null, home: null }));
    await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    for (const [, set] of NOT_MINE) {
      Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
      await show();
      set();
      await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
    for (const set of [() => { state.grants['assistant-open'] = false; }, () => { state.enabled = false; }]) {
      Object.assign(state, { enabled: true, grants: { 'assistant-status': true, 'assistant-open': true } });
      set();
      await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    for (const change of [() => { state.owner = OTHER; }, () => { state.grants['assistant-open'] = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, { owner: OWNER, handle: 'h1', enabled: true, grants: { 'assistant-status': true, 'assistant-open': true } });
      state.afterRead = change;
      await expect(appAssistantOpen(APP, { name: 'main', screen }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('the App hears only that a host page is open, then closed — never which, nor what it shows', async () => {
    await show();
    hear.mockReset();
    await appHostLayerChanged({ extensionId: APP, layer: { kind: 'assistant-projects', ownerId: OWNER } }, hear);
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: seen(status()), hostPage: true });
    expect(await appAssistantStatus(APP, { name: 'main' })).toMatchObject({ state: 'ready', hostPage: true });
    expect(JSON.stringify(hear.mock.calls)).not.toContain('projects');
    await appHostLayerChanged({ extensionId: APP, layer: { kind: 'assistant-projects', ownerId: OWNER } }, hear);
    expect(hear).toHaveBeenCalledOnce();
    await appHostLayerChanged({ extensionId: APP, layer: null }, hear);
    expect(hear).toHaveBeenLastCalledWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: seen(status()), hostPage: false });
    expect(await appAssistantStatus(APP, { name: 'main' })).toMatchObject({ hostPage: false });
  });

  it('a layer opened for another account is not this one\'s; an App not entitled hears nothing of it', async () => {
    await show();
    hear.mockReset();
    await appHostLayerChanged({ extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OTHER } }, hear);
    expect(await appAssistantStatus(APP, { name: 'main' })).toMatchObject({ hostPage: false });
    state.grants['assistant-status'] = false;
    await appHostLayerChanged({ extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OWNER } }, hear);
    state.grants['assistant-status'] = true;
    state.selectedBy = '';
    await appHostLayerChanged({ extensionId: APP, layer: null }, hear);
    expect(hear.mock.calls.filter(([, event]) => (event as { hostPage?: boolean }).hostPage === true)).toEqual([]);
  });

  it('takes only a known App and a known page, for an account', async () => {
    for (const bad of [
      { extensionId: APP, layer: { kind: 'assistant-memory', ownerId: OWNER } }, { extensionId: APP, layer: { kind: 'assistant-settings' } },
      { extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OWNER, path: '/x' } }, { extensionId: APP }, { extensionId: '', layer: null },
    ]) await expect(appHostLayerChanged(bad, hear)).rejects.toMatchObject({ code: 'invalid' });
    await expect(appHostLayerChanged({ extensionId: 'another-app', layer: null }, hear)).rejects.toMatchObject({ code: 'denied' });
  });
});

describe('gugu.assistant.rename: the shell\'s own renameAssistant, by the built-in field\'s rule', () => {
  const rename = (text: unknown, act = vi.fn(async (_action: ExtensionHostAction) => undefined)) => appAssistantRename(APP, { name: 'main', text }, act);

  it('renames, trimmed, through the window for the account checked', async () => {
    await show();
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    expect(await rename('  Pip  ', act)).toBe('renamed');
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'renameAssistant', text: 'Pip', ownerId: OWNER });
  });

  it('answers from a closed set: the same name, empty, too long — nothing saved; a failed save is failed', async () => {
    await show();
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    expect(await rename(' Dot ', act)).toBe('unchanged');
    expect(await rename('   ', act)).toBe('empty');
    expect(await rename('x'.repeat(31), act)).toBe('too-long');
    expect(await rename('x'.repeat(30), act)).toBe('renamed');
    expect(act).toHaveBeenCalledOnce();
    expect(await rename('Pip', vi.fn(async () => { throw new Error('offline'); }))).toBe('failed');
  });

  it('refused unbound, not the assistant chat, without its own grant (open is not enough), disabled, or changed mid-request', async () => {
    const act = vi.fn(async () => undefined);
    await show();
    state.selectedBy = '';
    await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    for (const [, set] of NOT_MINE) {
      Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
      set();
      await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
    const all = () => ({ enabled: true, grants: { 'assistant-status': true, 'assistant-open': true, 'assistant-rename': true }, declared: ['unread', 'assistant-status', 'assistant-open', 'assistant-rename'] });
    for (const set of [() => { state.grants['assistant-rename'] = false; }, () => { state.enabled = false; }, () => { state.declared = ['unread', 'assistant-status', 'assistant-open']; }]) {
      Object.assign(state, all());
      set();
      await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'denied' });
    }
    for (const change of [() => { state.owner = OTHER; }, () => { state.grants['assistant-rename'] = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, all(), { owner: OWNER, handle: 'h1' });
      state.afterRead = change;
      await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('fails, saving nothing, while the window has not shown the assistant', async () => {
    const act = vi.fn(async () => undefined);
    await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'failed' });
    await show(status({ assistant: 'loading', name: null, avatar: null, home: null }));
    await expect(rename('Pip', act)).rejects.toMatchObject({ code: 'failed' });
    expect(act).not.toHaveBeenCalled();
  });

  it('takes the binding\'s name and a string: anything more, or else, is refused before anything is asked', async () => {
    const act = vi.fn(async () => undefined);
    for (const args of [{ name: 'main' }, { name: 'main', text: 3 }, { name: 'main', text: 'x'.repeat(1001) }, { name: 'main', text: 'Pip', ownerId: OWNER }, { text: 'Pip' }]) {
      await expect(appAssistantRename(APP, args, act)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(state.reads).toBe(0);
    expect(act).not.toHaveBeenCalled();
  });
});

describe('gugu.assistant.figure: the assistant moving, drawn by the host over the App\'s page', () => {
  const WHERE = { x: 24, y: 40, size: 96 };
  const figure = (value: unknown, act = vi.fn(async (_action: ExtensionHostAction) => undefined)) => appAssistantFigure(APP, { name: 'main', figure: value }, act);

  it('the bound assistant\'s, for the account checked — no id of it reaches the action', async () => {
    await show();
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await figure(WHERE, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'assistantFigure', figure: WHERE, ownerId: OWNER, who: 'assistant' });
  });

  it('with no assistant yet: the setup guide\'s bird, whatever conversation is chosen, as status answers', async () => {
    state.selectedBy = '';
    state.provisions = [];
    await show(status({ assistant: 'none', name: null, avatar: null, home: null, setup: 'shell' }));
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await figure(WHERE, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'assistantFigure', figure: WHERE, ownerId: OWNER, who: 'draft' });
  });

  it('the assistant gone while the chat is checked: the bird, never the assistant\'s figure', async () => {
    await show();
    state.afterRead = () => {
      state.afterRead = undefined;
      void assistantStatusChanged({ ownerId: OWNER, status: status({ assistant: 'none', name: null, avatar: null, home: null, setup: 'shell' }) }, () => {});
    };
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await figure(WHERE, act);
    expect(act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ who: 'draft' }));
  });

  it('null takes it away with nothing asked', async () => {
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    await figure(null, act);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'assistantFigure', figure: null, ownerId: null, who: 'assistant' });
    expect(state.reads).toBe(0);
  });

  // Owner 11-12「怎么这里多了个鸟?」: the intro asked for its face's place as setup finished, then gave way to the panel and took
  // it away. The place was still being checked when the null (checked by nothing) was drawn, and was drawn after it: the bird
  // floated over the 任务 tab for good. The last call wins: a place still being checked when a later call comes is dropped.
  it('a place still being checked when the page takes the figure away is dropped: the null is the last word', async () => {
    await show();
    const acts: ExtensionHostAction[] = [];
    const act = vi.fn(async (action: ExtensionHostAction) => { acts.push(action); return undefined; });
    let away: Promise<void> | null = null;
    state.afterRead = () => {
      state.afterRead = undefined;
      away = figure(null, act);
    };
    await figure(WHERE, act);
    await away;
    expect(acts).toEqual([{ kind: 'assistantFigure', figure: null, ownerId: null, who: 'assistant' }]);
    // A place asked after the null is drawn as before; and of two places, the later one.
    acts.length = 0;
    await figure(WHERE, act);
    expect(acts).toEqual([{ kind: 'assistantFigure', figure: WHERE, ownerId: OWNER, who: 'assistant' }]);
    acts.length = 0;
    const MOVED = { x: 200, y: 300, size: 96 };
    let moved: Promise<void> | null = null;
    state.afterRead = () => {
      state.afterRead = undefined;
      moved = figure(MOVED, act);
    };
    await figure(WHERE, act);
    await moved;
    expect(acts).toEqual([{ kind: 'assistantFigure', figure: MOVED, ownerId: OWNER, who: 'assistant' }]);
  });

  it('refused unbound, not the assistant chat, without assistant:status, disabled, or changed mid-request; failed before the window showed it', async () => {
    const act = vi.fn(async () => undefined);
    await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'failed' });
    await show();
    state.selectedBy = '';
    await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'not-found' });
    state.selectedBy = OWNER;
    for (const [, set] of NOT_MINE) {
      Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
      set();
      await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'denied' });
    }
    Object.assign(state, { provisions: [provision(ASSISTANT)], chatKind: 'dm', members: [OWNER, ASSISTANT] });
    const all = () => ({ enabled: true, grants: { 'assistant-status': true, 'assistant-open': true, 'assistant-rename': true }, declared: ['unread', 'assistant-status', 'assistant-open', 'assistant-rename'] });
    for (const set of [() => { state.grants['assistant-status'] = false; }, () => { state.enabled = false; }, () => { state.installed = false; }]) {
      Object.assign(state, all(), { installed: true });
      set();
      await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'denied' });
    }
    for (const change of [() => { state.owner = OTHER; }, () => { state.grants['assistant-status'] = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, all(), { installed: true, owner: OWNER, handle: 'h1' });
      state.afterRead = change;
      await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'denied' });
    }
    // Another account's window: its snapshot is not this one's, and neither is the bird.
    Object.assign(state, all(), { installed: true, owner: OWNER, handle: 'h1', afterRead: undefined, provisions: [] });
    forgetShownAssistantForTest();
    await show(status({ assistant: 'none', name: null, avatar: null, home: null, setup: 'shell' }), OTHER);
    state.selectedBy = '';
    await expect(figure(WHERE, act)).rejects.toMatchObject({ code: 'not-found' });
    expect(act).not.toHaveBeenCalled();
  });

  it('takes the binding\'s name and { x, y, size } in range: anything more, or else, is refused before anything is asked', async () => {
    const act = vi.fn(async () => undefined);
    for (const value of [{ x: 0, y: 0 }, { x: 0, y: 0, size: 8 }, { x: 0, y: 0, size: 600 }, { x: 0, y: 0, size: 64.5 }, { x: Infinity, y: 0, size: 64 },
      { x: 0, y: 0, size: 64, avatar: 'data:' }, 'top-left', undefined]) {
      await expect(appAssistantFigure(APP, value === undefined ? { name: 'main' } : { name: 'main', figure: value }, act)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appAssistantFigure(APP, { name: 'main', figure: WHERE, ownerId: OWNER }, act)).rejects.toMatchObject({ code: 'invalid' });
    expect(state.reads).toBe(0);
    expect(act).not.toHaveBeenCalled();
  });
});

describe('disabling or uninstalling the App is not closing the assistant', () => {
  it('nothing reaches the window — no close, no screen — and the App can no longer ask for one', async () => {
    await show();
    hear.mockReset();
    const act = vi.fn(async () => undefined);
    for (const set of [() => { state.enabled = false; }, () => { state.installed = false; }]) {
      Object.assign(state, { installed: true, enabled: true });
      set();
      await show(status({ name: `after ${state.enabled ? 'uninstall' : 'disable'}` }));
      await expect(appAssistantOpen(APP, { name: 'main', screen: 'close' }, act)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
    expect(hear).not.toHaveBeenCalled();
  });
});
