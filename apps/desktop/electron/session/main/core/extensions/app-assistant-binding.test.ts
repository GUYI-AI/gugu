import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_SCREENS, type AppAssistantStatus } from '@shared/extensions/assistant-binding';
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
  hasCapability: (_app: string, capability: string) => state.grants[capability === 'assistant:status' ? 'assistant-status' : 'assistant-open'] === true,
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
const { appAssistantStatus, appAssistantOpen, appAssistantAdvanceSetup, assistantStatusChanged, forgetShownAssistantForTest } = binding;

const provision = (agent: string, removed: string | null = null) => ({
  agent_user_id: agent, device_id: DEVICE, member_key: 'assistant', phase: 'ready', created_at: '2026-11-01T00:00:00Z', agent: { removed_at: removed },
});
const status = (over: Partial<AppAssistantStatus> = {}): AppAssistantStatus => ({
  assistant: 'found', name: 'Dot', avatar: 'data:image/webp;base64,UklGRg==', home: { kind: 'this-computer', online: true },
  setup: 'connect', preparing: false, cloudAvailable: true, member: null, loadError: null, ...over,
});
const hear = vi.fn();
const show = (value = status(), ownerId = OWNER) => assistantStatusChanged({ ownerId, status: value }, hear);
const IDS = [OWNER, OTHER, CHAT, ASSISTANT, DEVICE, STRANGER, 'h1'];
const leaks = (said: unknown) => IDS.filter((id) => JSON.stringify(said).includes(id));

beforeEach(() => {
  forgetShownAssistantForTest();
  Object.assign(state, {
    owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true,
    grants: { 'assistant-status': true, 'assistant-open': true }, declared: ['unread', 'assistant-status', 'assistant-open'],
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
    expect(read).toEqual({ name: 'main', state: 'ready', status: status() });
    expect(leaks(read)).toEqual([]);
    // Exactly the fields the built-in view holds and an App needs to pick what to draw.
    expect(Object.keys((read as { status: object }).status).sort()).toEqual(['assistant', 'avatar', 'cloudAvailable', 'home', 'loadError', 'member', 'name', 'preparing', 'setup']);
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
  it.each(ASSISTANT_SCREENS)('%s: the window is asked to open exactly that screen, for the account checked', async (screen) => {
    const act = vi.fn(async (_action: ExtensionHostAction) => undefined);
    expect(await appAssistantOpen(APP, { name: 'main', screen }, act)).toBeUndefined();
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'openAssistantScreen', screen, ownerId: OWNER });
  });

  it('refuses any other value, or anything more than the value, before anything is asked', async () => {
    const act = vi.fn(async () => undefined);
    for (const args of [
      { name: 'main', screen: 'settings' }, { name: 'main', screen: 'Setup' }, { name: 'main', screen: '' }, { name: 'main', screen: 'close ' },
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
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: status() });
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
  const without = (assistant: (typeof NO_ASSISTANT)[number], over: Partial<AppAssistantStatus> = {}) =>
    status({ assistant, setup: assistant === 'none' ? 'shell' : null, preparing: false, member: false, ...over });
  const stripped = (value: AppAssistantStatus) => ({ ...value, name: null, avatar: null, home: null });

  it.each(NO_ASSISTANT)('%s, no conversation chosen: status is the snapshot without one — no name, look or home, nothing asked', async (assistant) => {
    state.selectedBy = '';
    state.provisions = [];
    await show(without(assistant));
    state.reads = 0;
    const read = await appAssistantStatus(APP, { name: 'main' });
    expect(read).toEqual({ name: 'main', state: 'ready', status: stripped(without(assistant)) });
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
    expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'ready', status: stripped(gone) });
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
      expect(await appAssistantStatus(APP, { name: 'main' })).toEqual({ name: 'main', state: 'ready', status: stripped(without('none')) });
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
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('none')) }],
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('none', { preparing: true })) }],
      [APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: stripped(without('loading', { preparing: true })) }],
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
    expect(hear).toHaveBeenCalledExactlyOnceWith(APP, { type: 'assistantChanged', name: 'main', state: 'ready', status: status({ setup: 'ready' }) });
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
