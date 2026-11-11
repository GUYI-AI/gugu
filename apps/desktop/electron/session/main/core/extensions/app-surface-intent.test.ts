import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (API 48) A `page-intent` (a composer entry the person clicked, or the host's recording bar) told to the page drawn
 * beside the bound conversation: once, its panel expanded and any host page over it closed first — only that page, only for
 * the person, only while `appBindingSurface` says it is drawn there (the fakes are app-conversation-surface.test.ts's).
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
const { reportConversationSurface, tellSurfaceIntent } = await import('./app-unread-bindings');
const { forgetHostLayersForTest, reportHostLayer } = await import('./app-host-layers');
const IDEAS = { kind: 'composer-action', id: 'ideas' } as const;

// The corner the host's collapse control covers, the built-in panel's top row: the same answer at every width.
const INSET = { top: 52, right: 48 };
const show = (collapsed = false, chatId = CHAT) => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: { chatId, collapsed } });
const hide = () => reportConversationSurface({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: null });

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, memberError: false, granted: true, placed: true, afterMember: undefined, asked: [] });
  hide();
  forgetHostLayersForTest();
});

type Page = { tabName: string; tabId: string; person: boolean; uncover: () => Promise<unknown>; tell: (surface: unknown) => boolean };
function page(tabName: string, tabId: string, person = true) {
  const heard: unknown[] = [];
  const expanded: true[] = [];
  const it: Page = { tabName, tabId, person, uncover: async () => { expanded.push(true); }, tell: (surface) => { heard.push(surface); return true; } };
  return { it, heard, expanded };
}

describe('a page intent', () => {
  it('told once to the page drawn beside, its panel expanded first; no chat, owner or handle with it', async () => {
    const main = page('main', 'dock');
    const elsewhere = page('main', 'session-tab-7');
    const other = page('other', 'dock');
    show(true);
    expect(await tellSurfaceIntent('today', IDEAS, [main.it, elsewhere.it, other.it])).toBe(true);
    expect(main.expanded).toEqual([true]);
    expect(main.heard).toEqual([{ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: false, inset: INSET, hostPage: false }, intent: IDEAS }]);
    for (const secret of [CHAT, OWNER, 'h1']) expect(JSON.stringify(main.heard)).not.toContain(secret);
    expect([elsewhere.heard, other.heard, elsewhere.expanded, other.expanded]).toEqual([[], [], [], []]);
    // Open already: told, nothing to expand.
    show(false);
    const open = page('main', 'dock');
    await tellSurfaceIntent('today', IDEAS, [open.it]);
    expect(open.expanded).toEqual([]);
    expect(open.heard).toHaveLength(1);
    // Open, with a host page over it (the assistant's settings): that page is closed first, as for the row's profile.
    reportHostLayer({ extensionId: 'today', layer: { kind: 'assistant-settings', ownerId: OWNER } });
    const covered = page('main', 'dock');
    await tellSurfaceIntent('today', { kind: 'voice-note' }, [covered.it]);
    expect(covered.expanded).toEqual([true]);
    expect(covered.heard).toEqual([{ name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: false, inset: INSET, hostPage: false }, intent: { kind: 'voice-note' } }]);
  });

  it('nobody hears it while nothing is drawn there, for another account, an agent\'s page, the grant gone or the App not placed', async () => {
    for (const set of [
      () => { hide(); },
      () => { show(false, ELSEWHERE); },
      () => { state.owner = OTHER; },
      () => { state.granted = false; },
      () => { state.enabled = false; },
      () => { state.member = false; },
    ]) {
      Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, granted: true });
      show(true);
      set();
      const main = page('main', 'dock');
      expect(await tellSurfaceIntent('today', IDEAS, [main.it])).toBe(false);
      expect([main.heard, main.expanded]).toEqual([[], []]);
    }
    Object.assign(state, { owner: OWNER, member: true, granted: true, enabled: true });
    show(true);
    const agentPage = page('main', 'dock', false);
    expect(await tellSurfaceIntent('today', IDEAS, [agentPage.it])).toBe(false);
    expect([agentPage.heard, agentPage.expanded]).toEqual([[], []]);
    state.placed = false;
    const unplaced = page('main', 'dock');
    expect(await tellSurfaceIntent('today', IDEAS, [unplaced.it])).toBe(false);
    expect(unplaced.heard).toEqual([]);
  });
});
