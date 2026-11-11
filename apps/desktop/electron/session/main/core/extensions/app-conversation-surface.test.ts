import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 41): an App's main page drawn beside the conversation its binding is bound to. The window reports what it
 * draws (`reportConversationSurface`, trusted renderer only); the App is told `bound` only while that is the very
 * conversation the binding reaches — the current account's own selection for this installed App, `chat:surface` granted,
 * still a member, the same selection after the wait — and `unbound` for every other reason, never which. It names only the
 * binding; it hears back neither the chat nor anyone in it. The real service's grant rules are app-unread-bindings.test.ts's.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ELSEWHERE = '55000000-0000-4000-8000-000000000005';
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, member: true, memberError: false, granted: true, placed: true,
  afterMember: undefined as (() => void) | undefined,
  asked: [] as string[],
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
const manifest = () => ({ id: 'today', contributes: state.placed ? { conversationSurface: { binding: 'main', placement: 'side-panel' } } : {} });
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  get: () => ({ manifest: manifest() }),
  list: () => ({ extensions: state.installed ? [{ manifest: manifest() }] : [] }),
  isEnabled: () => state.enabled,
  hasCapability: (_id: string, word: string) => word === 'chat:surface' && state.granted,
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.granted || !['surface', 'draft'].includes(action) || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  },
  conversationSurfaceAuthority: (owner: string, _app: string, name: string) => {
    if (!state.installed || !state.enabled || !state.granted || name !== 'main') throw denied('no grant');
    return `stamp-${owner}-${state.handle}`;
  },
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: (table: string) => {
  state.asked.push(table);
  const query = {
    select: (columns: string) => { state.asked.push(`select ${columns}`); return query; },
    eq: () => query,
    maybeSingle: async () => {
      state.afterMember?.();
      return state.memberError ? { data: null, error: { message: 'down' } } : { data: state.member ? { chat_id: CHAT } : null, error: null };
    },
    in: async (_column: string, ids: string[]) => ({ data: state.member ? ids.map((chat_id) => ({ chat_id })) : [], error: state.memberError ? {} : null }),
  };
  return query;
} }) }));
const { appBindingSurface, draftIntoBoundConversation, grantedSurfaceBindings, reportConversationSurface, setBindingSurfacePanel } = await import('./app-unread-bindings');

const MAIN = { tabName: 'main', tabId: 'dock' };
// The corner the host's collapse control covers, the built-in panel's top row: the same answer at every width.
const INSET = { top: 52, right: 48 };
const show = (collapsed = false, chatId = CHAT) => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: { chatId, collapsed } });
const hide = () => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: null });
const surface = (page = MAIN) => appBindingSurface('today', page, { name: 'main' });

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, memberError: false, granted: true, placed: true, afterMember: undefined, asked: [] });
  hide();
});

describe('what the App is told of the conversation beside its page', () => {
  it('bound only while the window draws the bound conversation beside this page; the answer names no chat, person or handle', async () => {
    expect(await surface()).toEqual({ name: 'main', state: 'unbound' });
    expect(show()).toBe(true);
    const bound = await surface();
    expect(bound).toEqual({ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: false, inset: INSET, hostPage: false } });
    for (const secret of [CHAT, OWNER, 'h1']) expect(JSON.stringify(bound)).not.toContain(secret);
    expect(show(true)).toBe(true);
    expect(await surface()).toEqual({ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: true, inset: INSET, hostPage: false } });
    // The same report again changes nothing anyone hears.
    expect(show(true)).toBe(false);
    expect(hide()).toBe(true);
    expect(await surface()).toEqual({ name: 'main', state: 'unbound' });
  });

  it('a window drawing another conversation, or this page somewhere else, is unbound', async () => {
    show(false, ELSEWHERE);
    expect(await surface()).toEqual({ name: 'main', state: 'unbound' });
    show();
    expect(await surface({ tabName: 'main', tabId: 'session-tab-7' })).toEqual({ name: 'main', state: 'unbound' });
    expect(await surface({ tabName: 'other', tabId: 'dock' })).toEqual({ name: 'main', state: 'unbound' });
    // Another tab's report says nothing of this one: it is not taken down by it.
    expect(reportConversationSurface({ extensionId: 'today', tabKind: 'today.other', tabId: 'dock', shown: null })).toBe(false);
    expect(await surface()).toMatchObject({ state: 'bound' });
    expect(() => reportConversationSurface({ extensionId: 'today', tabKind: 'elsewhere.main', tabId: 'dock', shown: null })).toThrow();
  });

  it('an App cannot name a conversation, account or handle; only its declared binding', async () => {
    show();
    for (const extra of [{ chat: CHAT }, { chatId: CHAT }, { ownerId: OWNER }, { handle: 'h1' }, { id: CHAT }, { place: { chat: CHAT } }]) {
      await expect(appBindingSurface('today', MAIN, { name: 'main', ...extra })).rejects.toMatchObject({ code: 'invalid' });
      await expect(setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true, ...extra }, async () => undefined)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appBindingSurface('today', MAIN, { name: 'other' })).rejects.toMatchObject({ code: 'denied' });
    await expect(appBindingSurface('today', MAIN, { name: 7 })).rejects.toMatchObject({ code: 'invalid' });
    state.placed = false;
    await expect(surface()).rejects.toMatchObject({ code: 'denied' });
  });

  it('unbound, never why: no choice, another account, the grant withdrawn, disabled, uninstalled, no longer a member', async () => {
    show();
    for (const set of [
      () => { state.selectedBy = ''; },
      () => { state.owner = OTHER; },
      () => { state.owner = ''; },
      () => { state.granted = false; },
      () => { state.enabled = false; },
      () => { state.installed = false; },
      () => { state.member = false; },
      () => { state.memberError = true; },
    ]) {
      Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, memberError: false, granted: true });
      set();
      expect(await surface()).toEqual({ name: 'main', state: 'unbound' });
    }
  });

  it('a switch, withdrawal, replacement or hide during the membership check is unbound too', async () => {
    show();
    for (const change of [
      () => { state.owner = OTHER; }, () => { state.granted = false; }, () => { state.installed = false; },
      () => { state.handle = 'h2'; }, () => { hide(); }, () => { show(false, ELSEWHERE); },
    ]) {
      Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, granted: true });
      show();
      state.afterMember = change;
      expect(await surface()).toEqual({ name: 'main', state: 'unbound' });
      state.afterMember = undefined;
    }
  });

  it('setPanel asks the window only while bound, only for a change, and answers the panel as asked', async () => {
    const ask = vi.fn(async () => undefined);
    expect(await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true }, ask)).toEqual({ name: 'main', state: 'unbound' });
    expect(ask).not.toHaveBeenCalled();
    show();
    expect(await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true }, ask)).toEqual({ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: true, inset: INSET, hostPage: false } });
    expect(ask).toHaveBeenCalledExactlyOnceWith(true);
    show(true);
    ask.mockClear();
    expect(await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true }, ask)).toEqual({ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: true, inset: INSET, hostPage: false } });
    expect(ask).not.toHaveBeenCalled();
    state.granted = false;
    expect(await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: false }, ask)).toEqual({ name: 'main', state: 'unbound' });
    expect(ask).not.toHaveBeenCalled();
    for (const collapsed of ['yes', 1, null, undefined]) {
      await expect(setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed }, ask)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('a draft to the binding goes into the very conversation drawn beside the page, and the answer names no chat', async () => {
    show();
    const draftInChat = vi.fn(async () => undefined);
    const answer = await draftIntoBoundConversation('today', { text: 'What is first today?', draft: true, to: { binding: 'main' } }, draftInChat);
    expect(draftInChat).toHaveBeenCalledExactlyOnceWith({ chatId: CHAT, text: 'What is first today?\n' });
    expect(await surface()).toEqual({ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: false, inset: INSET, hostPage: false } });
    expect(JSON.stringify(answer)).not.toContain(CHAT);
  });

  it('asking marks nothing read: it reads only who is a member, and writes nothing', async () => {
    show();
    await surface();
    await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true }, async () => undefined);
    await grantedSurfaceBindings(OWNER);
    expect(new Set(state.asked)).toEqual(new Set(['active_members', 'select chat_id']));
  });
});

describe('which conversation the window may draw (host projection)', () => {
  it('the Apps placing their page beside a binding, granted, enabled, of a conversation the account is still in', async () => {
    // With the stamp of that authority, read in the same step as the last check (the service keeps it: app-unread-bindings.test.ts).
    expect(await grantedSurfaceBindings(OWNER)).toEqual({ today: { ownerId: OWNER, name: 'main', chatId: CHAT, handle: 'h1', authority: `stamp-${OWNER}-h1`, header: null } });
    for (const set of [() => { state.granted = false; }, () => { state.enabled = false; }, () => { state.placed = false; }, () => { state.member = false; }, () => { state.selectedBy = ''; }, () => { state.installed = false; }]) {
      Object.assign(state, { selectedBy: OWNER, installed: true, enabled: true, member: true, granted: true, placed: true });
      set();
      expect(await grantedSurfaceBindings(OWNER)).toEqual({});
    }
  });

  it('refuses another account, and an unverifiable membership is a failure, not an empty answer', async () => {
    await expect(grantedSurfaceBindings(OTHER)).rejects.toMatchObject({ code: 'denied' });
    state.memberError = true;
    await expect(grantedSurfaceBindings(OWNER)).rejects.toMatchObject({ code: 'failed' });
  });
});
