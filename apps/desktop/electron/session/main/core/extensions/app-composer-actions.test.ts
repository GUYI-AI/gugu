import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (API 48) The composer 「+」 entries an App placed beside the person's own assistant chat declares: which the window
 * draws, and the host running the one clicked. The window names the App, the column's authority and an entry's id — never a
 * text, an intent or a chat; what runs is the App as installed, through the host's own paths (the recorder's, the page's
 * surface event), and nothing reaches the App's code but a `page-intent`. Refused: another account, the App off, a stale
 * column, a run not granted, a conversation that is not the person's private one with their own assistant — checked again
 * after the wait.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const JOB = '55000000-0000-4000-8000-000000000005';
const RESEARCHER = '66000000-0000-4000-8000-000000000006';
const STAMP = '77000000-0000-4000-8000-000000000007';
const ASSISTANT = { agent_user_id: AGENT, member_key: 'assistant', device_id: 'home-device', phase: 'completed', created_at: '2026-11-01T00:00:00Z',
  dm_chat_id: CHAT, agent: { owner_user_id: OWNER, removed_at: null } };
const IDLE = { recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null }, jobs: [] };
const ENTRIES = [
  { id: 'ideas', label: { zh: '获取灵感', en: 'Get ideas' }, icon: 'sparkles', run: { kind: 'page-intent' } },
  { id: 'voice-note', label: { zh: '录制语音笔记', en: 'Record a voice note' }, icon: 'mic', run: { kind: 'voice-note' } },
  { id: 'ask', label: { zh: '问问它', en: 'Ask it' }, icon: 'message', run: { kind: 'draft', text: { zh: '帮我看看今天的安排。', en: 'Look at my day with me.' } } },
];
const CAPABILITY: Record<string, string> = { surface: 'chat:surface', draft: 'chat:draft', 'voice-notes:record': 'chat:voice-notes:record' };

const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, revoked: [] as string[], member: true, stamp: '', header: undefined as string | undefined,
  provisions: [] as Record<string, unknown>[], entries: [] as unknown[],
  asked: [] as Record<string, unknown>[], answer: null as null | ((request: Record<string, unknown>) => unknown),
  /** Runs while the store is asked (the wait every call has): what changes meanwhile. */
  during: undefined as (() => void) | undefined,
  told: [] as [string, unknown][],
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token || null }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => {
    const on = () => state.installed && state.enabled;
    const has = (capability: string) => on() && !state.revoked.includes(capability);
    return {
      isInstalled: () => state.installed,
      isEnabled: () => state.enabled,
      get: () => ({ manifest: { id: 'assistant', contributes: { conversationSurface: { binding: 'main', placement: 'side-panel', composerActions: state.entries,
        ...(state.header ? { header: state.header } : {}) } } } }),
      hasCapability: (_app: string, capability: string) => has(capability),
      conversationBinding: (owner: string, _app: string, name: string, action: string) => {
        if (!on() || name !== 'main' || !has(CAPABILITY[action] ?? '-')) throw denied('no grant');
        return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
      },
      conversationSurfaceAuthority: (owner: string, _app: string, name: string) => {
        if (!on() || name !== 'main' || !has('chat:surface')) throw denied('no grant');
        return owner === OWNER && state.handle === 'h1' ? state.stamp : '88000000-0000-4000-8000-000000000008';
      },
      onBindingAuthorityChanged: () => () => undefined,
    };
  },
}));
vi.mock('./extension-bridge-relay', () => ({
  askVoiceNoteWindow: async (request: Record<string, unknown>) => {
    state.asked.push(request);
    return state.answer ? state.answer(request) : { state: 'ready', view: IDLE };
  },
}));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query, limit: () => query, eq: () => query,
        maybeSingle: async () => { state.during?.(); return { data: state.member ? { chat_id: CHAT } : null, error: null }; },
        abortSignal: async () => table === 'agent_provisions' ? { data: state.provisions, error: null } : { data: null, error: { message: 'unexpected' } },
      };
      return query;
    },
  }),
}));

const { composerActionsFor, customizeOpenedBeside, runComposerAction, voiceNoteOpenedBeside } = await import('./app-composer-actions');
const column = { ownerId: OWNER, extensionId: 'assistant', authority: STAMP };
const tellPage = async (extensionId: string, intent: unknown) => { state.told.push([extensionId, intent]); return true; };
const run = (actionId: string, extra: Record<string, unknown> = {}) => runComposerAction({ ...column, actionId, ...extra }, tellPage);
const list = async () => (await composerActionsFor(column)).actions.map((entry) => entry.id);

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, revoked: [], member: true, stamp: STAMP,
    provisions: [ASSISTANT], entries: ENTRIES, asked: [], answer: null, during: undefined, told: [], header: undefined });
});

describe('the entries the window draws', () => {
  it('the App\'s, in its order, with only what drawing them takes — for the person\'s own assistant chat', async () => {
    expect(await composerActionsFor(column)).toEqual({ actions: [
      { id: 'ideas', label: { zh: '获取灵感', en: 'Get ideas' }, icon: 'sparkles', kind: 'page-intent' },
      { id: 'voice-note', label: { zh: '录制语音笔记', en: 'Record a voice note' }, icon: 'mic', kind: 'voice-note' },
      { id: 'ask', label: { zh: '问问它', en: 'Ask it' }, icon: 'message', kind: 'draft' },
    ] });
    expect(JSON.stringify(await composerActionsFor(column))).not.toMatch(/帮我看看|Look at my day|"intent"|"text"/);
  });

  it('an entry the App marks `chip` says so, with that label: the window draws it above the composer too', async () => {
    state.entries = [{ ...ENTRIES[0], chip: { zh: '灵感', en: 'Ideas' } }, ENTRIES[1]];
    expect((await composerActionsFor(column)).actions.map((entry) => [entry.id, entry.chip ?? null]))
      .toEqual([['ideas', { zh: '灵感', en: 'Ideas' }], ['voice-note', null]]);
  });

  it('none beside any other conversation; a run not granted is not drawn', async () => {
    for (const provisions of [[{ ...ASSISTANT, member_key: 'researcher' }], [{ ...ASSISTANT, dm_chat_id: OTHER }],
      [{ ...ASSISTANT, dm_chat_id: OTHER }, { ...ASSISTANT, agent_user_id: RESEARCHER, member_key: 'researcher', dm_chat_id: CHAT }]]) {
      state.provisions = provisions;
      expect(await list()).toEqual([]);
    }
    state.provisions = [ASSISTANT];
    state.revoked = ['chat:voice-notes:record'];
    expect(await list()).toEqual(['ideas', 'ask']);
    state.revoked = ['chat:draft'];
    expect(await list()).toEqual(['ideas', 'voice-note']);
  });

  it('refused for another account, the App off or gone, a column drawn under an earlier authority', async () => {
    await expect(composerActionsFor({ ...column, ownerId: OTHER })).rejects.toMatchObject({ code: 'denied' });
    state.enabled = false;
    await expect(composerActionsFor(column)).rejects.toMatchObject({ code: 'denied' });
    state.enabled = true; state.installed = false;
    await expect(composerActionsFor(column)).rejects.toMatchObject({ code: 'denied' });
    state.installed = true; state.handle = 'h2';
    await expect(composerActionsFor(column)).rejects.toMatchObject({ code: 'denied' });
  });
});

describe('the host runs the one clicked', () => {
  it('a draft: the App\'s text as installed, for the window to put in its composer; nothing else happens', async () => {
    expect(await run('ask')).toEqual({ kind: 'draft', text: { zh: '帮我看看今天的安排。', en: 'Look at my day with me.' } });
    expect(state.asked).toEqual([]);
    expect(state.told).toEqual([]);
  });

  it('a page intent: the page drawn beside is told it, after every check', async () => {
    expect(await run('ideas')).toEqual({ kind: 'page-intent', delivered: true });
    expect(state.told).toEqual([['assistant', { kind: 'composer-action', id: 'ideas' }]]);
    expect(state.asked).toEqual([]);
  });

  it('a voice note: the recorder\'s own path, the host saying why if it cannot; the window told the account and assistant', async () => {
    state.answer = (request) => request.op === 'start'
      ? { state: 'ready', view: IDLE, started: { outcome: 'started', job: JOB } } : { state: 'ready', view: IDLE };
    expect(await run('voice-note')).toEqual({ kind: 'voice-note', outcome: 'started' });
    expect(state.asked[0]).toEqual({ op: 'start', ownerId: OWNER, assistantId: AGENT, present: true });
    state.answer = () => ({ state: 'ready', view: IDLE, started: { outcome: 'mic_denied' } });
    expect(await run('voice-note')).toEqual({ kind: 'voice-note', outcome: 'mic_denied' });
    expect(state.told).toEqual([]);
  });

  it('takes only the App, the column and an id: no text, intent, chat or owner of the window\'s own', async () => {
    for (const extra of [{ text: 'rm -rf' }, { intent: 'settings' }, { chatId: CHAT }, { run: { kind: 'draft', text: 'x' } }, { agentId: AGENT }]) {
      await expect(run('ask', extra)).rejects.toThrow();
    }
    await expect(run('missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(run('Ask!')).rejects.toThrow();
    expect(state.asked).toEqual([]);
    expect(state.told).toEqual([]);
  });
});

describe('refusals', () => {
  const nothingDone = () => {
    expect(state.asked).toEqual([]);
    expect(state.told).toEqual([]);
  };

  it('not the person\'s own assistant chat: refused, whatever the run', async () => {
    for (const provisions of [[{ ...ASSISTANT, member_key: 'researcher' }],
      [{ ...ASSISTANT, dm_chat_id: OTHER }, { ...ASSISTANT, agent_user_id: RESEARCHER, member_key: 'researcher', dm_chat_id: CHAT }]]) {
      state.provisions = provisions;
      for (const id of ['ideas', 'ask', 'voice-note']) await expect(run(id)).rejects.toMatchObject({ code: 'denied' });
    }
    state.provisions = [ASSISTANT]; state.member = false;
    for (const id of ['ideas', 'ask', 'voice-note']) await expect(run(id)).rejects.toMatchObject({ code: 'denied' });
    nothingDone();
  });

  it('the run\'s capability withdrawn: refused (the conversation and the other entries stay)', async () => {
    state.revoked = ['chat:draft'];
    await expect(run('ask')).rejects.toMatchObject({ code: 'denied' });
    state.revoked = ['chat:voice-notes:record'];
    await expect(run('voice-note')).rejects.toMatchObject({ code: 'denied' });
    nothingDone();
    state.revoked = ['chat:surface'];
    await expect(run('ideas')).rejects.toMatchObject({ code: 'denied' });
    nothingDone();
  });

  it('the App switched off or uninstalled while the click was checked: refused, nothing done', async () => {
    for (const lose of [() => { state.enabled = false; }, () => { state.installed = false; }]) {
      for (const id of ['ideas', 'ask', 'voice-note']) {
        Object.assign(state, { enabled: true, installed: true });
        state.during = lose;
        await expect(run(id)).rejects.toMatchObject({ code: 'denied' });
      }
    }
    nothingDone();
  });

  it('another account, before or during the click: refused, nothing done', async () => {
    await expect(run('ideas', { ownerId: OTHER })).rejects.toMatchObject({ code: 'denied' });
    for (const id of ['ideas', 'ask', 'voice-note']) {
      state.owner = OWNER;
      state.during = () => { state.owner = OTHER; };
      await expect(run(id)).rejects.toMatchObject({ code: 'denied' });
    }
    state.owner = '';
    state.during = undefined;
    await expect(run('ideas')).rejects.toMatchObject({ code: 'denied' });
    nothingDone();
  });

  it('a column drawn under an earlier authority (another conversation chosen since): refused', async () => {
    state.handle = 'h2';
    for (const id of ['ideas', 'ask', 'voice-note']) await expect(run(id)).rejects.toMatchObject({ code: 'denied' });
    // Changed while the click was checked.
    state.handle = 'h1';
    state.during = () => { state.handle = 'h3'; };
    await expect(run('ideas')).rejects.toMatchObject({ code: 'denied' });
    nothingDone();
  });
});

describe('the host\'s recording bar beside it', () => {
  it('opening the note it shows tells the page `voice-note`, for this account and an App that is on', async () => {
    expect(await voiceNoteOpenedBeside({ ownerId: OWNER, extensionId: 'assistant' }, tellPage)).toBe(true);
    expect(state.told).toEqual([['assistant', { kind: 'voice-note' }]]);
    await expect(voiceNoteOpenedBeside({ ownerId: OTHER, extensionId: 'assistant' }, tellPage)).rejects.toMatchObject({ code: 'denied' });
    state.enabled = false;
    expect(await voiceNoteOpenedBeside({ ownerId: OWNER, extensionId: 'assistant' }, tellPage)).toBe(false);
    await expect(voiceNoteOpenedBeside({ ownerId: OWNER, extensionId: 'assistant', intent: 'settings' }, tellPage)).rejects.toThrow();
    expect(state.told).toEqual([['assistant', { kind: 'voice-note' }]]);
  });
});

// Real window (verify-pass1 11-b): the built-in's 「自定义<name>」 hint above its composer was gone beside the App. The host
// draws it again; opened, the App's page is told to open its 自定义. Control (the parent commit): no such path.
describe('the host\'s 自定义 hint beside it', () => {
  it('opening it tells the page `customize`, for this account and an App on that declared the host\'s row over that chat', async () => {
    state.header = 'assistant';
    expect(await customizeOpenedBeside({ ownerId: OWNER, extensionId: 'assistant' }, tellPage)).toBe(true);
    expect(state.told).toEqual([['assistant', { kind: 'customize' }]]);
    await expect(customizeOpenedBeside({ ownerId: OTHER, extensionId: 'assistant' }, tellPage)).rejects.toMatchObject({ code: 'denied' });
    await expect(customizeOpenedBeside({ ownerId: OWNER, extensionId: 'assistant', intent: 'profile' }, tellPage)).rejects.toThrow();
    state.header = undefined;
    expect(await customizeOpenedBeside({ ownerId: OWNER, extensionId: 'assistant' }, tellPage)).toBe(false);
    state.header = 'assistant';
    state.enabled = false;
    expect(await customizeOpenedBeside({ ownerId: OWNER, extensionId: 'assistant' }, tellPage)).toBe(false);
    expect(state.told).toEqual([['assistant', { kind: 'customize' }]]);
  });
});
