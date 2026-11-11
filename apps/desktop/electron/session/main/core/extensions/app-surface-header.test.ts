import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 46) The host's row above the conversation beside an App (`contributes.conversationSurface.header: "assistant"`),
 * and the host pages over the App's panel. The window may draw the row only while main says so: the App declared it, and its
 * bound conversation — the account's own choice, granted, a member — is the account's private chat with its own assistant,
 * the same after the wait. A click on the assistant in that row is told to the page beside it once (`intent`), only under the
 * same rule. `panel.hostPage` says a host page is over the panel, for this account. None of it names a chat, person or page.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const WORK = 'a1000000-0000-4000-8000-0000000000a1';
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, member: true, granted: true, header: true as boolean,
  verdict: 'mine' as 'mine' | 'not-mine' | 'unverifiable',
  checked: [] as string[],
  afterCheck: undefined as (() => void) | undefined,
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
// The rule itself (provision marker, a dm of the two) is app-work-binding.test.ts's; here, its verdict.
vi.mock('./app-own-assistant-chat', () => ({ ownAssistantOfChat: async (_token: string, owner: string, chatId: string) => {
  state.checked.push(`${owner}:${chatId}`);
  state.afterCheck?.();
  if (state.verdict === 'unverifiable') throw Object.assign(new Error('down'), { code: 'failed' });
  if (state.verdict === 'not-mine') throw denied('not your assistant chat');
  return ASSISTANT;
} }));
const manifest = (id = 'today') => ({ id, apiVersion: 46, contributes: { conversationSurface: { binding: 'main', placement: 'side-panel', ...(state.header ? { header: 'assistant' } : {}) } } });
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  get: (id: string) => ({ manifest: manifest(id) }),
  list: () => ({ extensions: state.installed ? [{ manifest: manifest() }] : [] }),
  isEnabled: () => state.enabled,
  hasCapability: (_id: string, word: string) => word === 'chat:surface' && state.granted,
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.granted || action !== 'surface' || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  },
  conversationSurfaceAuthority: (owner: string) => `stamp-${owner}-${state.handle}`,
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: () => {
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: state.member ? { chat_id: CHAT } : null, error: null }),
    in: async (_column: string, ids: string[]) => ({ data: state.member ? ids.map((chat_id) => ({ chat_id })) : [], error: null }),
  };
  return query;
} }) }));
const { appBindingSurface, grantedSurfaceBindings, reportConversationSurface, setBindingSurfacePanel, surfaceIntentHolds, withIntent } = await import('./app-unread-bindings');
const { forgetHostLayersForTest, hostLayerOf, reportHostLayer } = await import('./app-host-layers');

const MAIN = { tabName: 'main', tabId: 'dock' };
const show = (extra: Record<string, unknown> = {}) => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: { chatId: CHAT, collapsed: false }, ...extra });
const surface = () => appBindingSurface('today', MAIN, { name: 'main' });
const fresh = () => Object.assign(state, {
  owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, granted: true, header: true, verdict: 'mine', checked: [], afterCheck: undefined,
});

beforeEach(() => {
  fresh();
  forgetHostLayersForTest();
  reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: null });
});

describe('the host\'s row above the conversation (which the window may draw)', () => {
  it('declared, over the account\'s own assistant chat: the row, verified as the account, chat by chat', async () => {
    expect((await grantedSurfaceBindings(OWNER)).today).toMatchObject({ chatId: CHAT, header: 'assistant' });
    expect(state.checked).toEqual([`${OWNER}:${CHAT}`]);
  });

  it('not declared, not the assistant chat, or not verifiable now: the conversation without the row, never held back', async () => {
    for (const set of [() => { state.header = false; }, () => { state.verdict = 'not-mine'; }, () => { state.verdict = 'unverifiable'; }]) {
      fresh();
      set();
      expect((await grantedSurfaceBindings(OWNER)).today).toMatchObject({ chatId: CHAT, header: null });
    }
    // Not declared: nothing asked about the assistant at all.
    fresh();
    state.header = false;
    await grantedSurfaceBindings(OWNER);
    expect(state.checked).toEqual([]);
  });

  it('a new choice, a withdrawn grant or the App switched off during that check: no row; another account: refused', async () => {
    for (const change of [() => { state.handle = 'h2'; }, () => { state.enabled = false; }, () => { state.granted = false; }]) {
      fresh();
      state.afterCheck = change;
      expect((await grantedSurfaceBindings(OWNER)).today?.header ?? null).toBeNull();
    }
    fresh();
    state.afterCheck = () => { state.owner = OTHER; };
    await expect(grantedSurfaceBindings(OWNER)).rejects.toMatchObject({ code: 'denied' });
  });
});

describe('the person\'s click on the assistant in that row (intent, told once)', () => {
  it('holds only for an App that declared the row, bound to the account\'s own assistant chat, unchanged after the check', async () => {
    expect(await surfaceIntentHolds('today')).toBe(true);
    for (const set of [
      () => { state.header = false; }, () => { state.verdict = 'not-mine'; }, () => { state.verdict = 'unverifiable'; },
      () => { state.selectedBy = ''; }, () => { state.granted = false; }, () => { state.enabled = false; }, () => { state.member = false; },
      () => { state.owner = ''; },
    ]) {
      fresh();
      set();
      expect(await surfaceIntentHolds('today')).toBe(false);
    }
    for (const change of [() => { state.owner = OTHER; }, () => { state.handle = 'h2'; }, () => { state.granted = false; }]) {
      fresh();
      state.afterCheck = change;
      expect(await surfaceIntentHolds('today')).toBe(false);
    }
  });

  it('rides on the answer of the page beside the conversation only; the window\'s report carries it only with that conversation', async () => {
    expect(withIntent({ name: 'main', state: 'unbound' }, { kind: 'profile' })).toEqual({ name: 'main', state: 'unbound' });
    const bound = { name: 'main', state: 'bound' as const, layout: 'side-panel' as const, panel: { collapsed: false, inset: { top: 52, right: 48 }, hostPage: false } };
    expect(withIntent(bound, { kind: 'profile' })).toEqual({ ...bound, intent: { kind: 'profile' } });
    expect(withIntent(bound, undefined)).toBe(bound);
    expect(show({ intent: 'profile' })).toBe(true);
    // An answer never carries it: only the one event after the click.
    expect(await surface()).not.toHaveProperty('intent');
    expect(() => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: null, intent: 'profile' })).toThrow();
    expect(() => show({ intent: 'settings' })).toThrow();
  });
});

describe('a host page over the App\'s panel (panel.hostPage)', () => {
  it('true while the window says one is there for this account — whichever kind — and never which', async () => {
    show();
    expect(await surface()).toMatchObject({ state: 'bound', panel: { hostPage: false } });
    expect(reportHostLayer({ extensionId: 'today', layer: { kind: 'assistant-settings', ownerId: OWNER } })).toBe(true);
    const covered = await surface();
    expect(covered).toMatchObject({ state: 'bound', panel: { hostPage: true } });
    expect(reportHostLayer({ extensionId: 'today', layer: { kind: 'work', ownerId: OWNER, workId: WORK, sessionId: 'exec-a' } })).toBe(true);
    const task = await surface();
    expect(task).toEqual(covered);
    for (const secret of [WORK, 'exec-a', 'work', 'settings', CHAT, OWNER]) expect(JSON.stringify(task)).not.toContain(secret);
    expect(await setBindingSurfacePanel('today', MAIN, { name: 'main', collapsed: true }, async () => undefined)).toMatchObject({ panel: { collapsed: true, hostPage: true } });
    expect(reportHostLayer({ extensionId: 'today', layer: null })).toBe(true);
    expect(await surface()).toMatchObject({ panel: { hostPage: false } });
  });

  it('another account\'s page, or another App\'s, is no page over this one', async () => {
    show();
    reportHostLayer({ extensionId: 'today', layer: { kind: 'assistant-settings', ownerId: OTHER } });
    expect(await surface()).toMatchObject({ panel: { hostPage: false } });
    expect(hostLayerOf('today', OWNER)).toBeNull();
    reportHostLayer({ extensionId: 'today', layer: null });
    reportHostLayer({ extensionId: 'elsewhere', layer: { kind: 'assistant-settings', ownerId: OWNER } });
    expect(await surface()).toMatchObject({ panel: { hostPage: false } });
    // The same report twice changes nothing anyone hears; a report naming more than the kind is refused.
    expect(reportHostLayer({ extensionId: 'elsewhere', layer: { kind: 'assistant-settings', ownerId: OWNER } })).toBe(false);
    expect(() => reportHostLayer({ extensionId: 'today', layer: { kind: 'assistant-settings', ownerId: OWNER, chatId: CHAT } })).toThrow();
  });
});
