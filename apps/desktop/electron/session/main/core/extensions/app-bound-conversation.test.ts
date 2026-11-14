import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppFileEntry } from '@shared/extensions/app-runtime-protocol';

/**
 * #1927 (API 40): an App's `files` and `draft` actions on the one conversation the person chose for its binding. The
 * authority is the signed-in account's own selection for this installed App, re-checked after every wait; the App names
 * only the binding and a path, and hears back neither the chat nor anyone in it. The real service's grant rules are in
 * app-unread-bindings.test.ts; the file reads' outcomes in app-files-bound-read.test.ts.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ELSEWHERE = '55000000-0000-4000-8000-000000000005';
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, member: true, memberError: false,
  grants: { files: true, draft: true } as Record<string, boolean>,
  afterMember: undefined as (() => void) | undefined,
}));
const files = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), resourceChat: vi.fn() }));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: files }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.grants[action] || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  },
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => {
    state.afterMember?.();
    return state.memberError ? { data: null, error: { message: 'down' } } : { data: state.member ? { chat_id: CHAT } : null, error: null };
  } };
  return query;
} }) }));
const { appBindingList, appBindingRead, draftIntoBoundConversation } = await import('./app-unread-bindings');

function entry(name: string, chat = CHAT): AppFileEntry {
  return { id: '66000000-0000-4000-8000-000000000006', chat, name, savedName: name, contentType: 'application/json', type: 'json', parentId: null,
    path: name, systemRole: null, suffix: '.json', displayName: name, claimedBy: { id: 'other-app', name: 'Other', icon: null }, appState: false,
    size: 12, version: 3, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T01:00:00Z',
    createdBy: { id: `user:${OTHER}`, name: 'Someone', kind: 'human' }, updatedBy: { id: `user:${OWNER}`, name: 'Me', kind: 'human' },
    sourceMessageIds: ['77000000-0000-4000-8000-000000000007'], metadata: { app: { secret: true } }, storedOn: { machine: 'MBP', owner: 'Me', mine: true } };
}
const ready = { state: 'ready', entry: entry('today.json'), content: '{"days":[]}', truncated: false, totalSize: 11 };
const reached = () => files.list.mock.calls.length + files.read.mock.calls.length;

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, memberError: false,
    grants: { files: true, draft: true }, afterMember: undefined });
  files.list.mockReset().mockResolvedValue([entry('today.json'), entry('elsewhere.json', ELSEWHERE)]);
  files.read.mockReset().mockResolvedValue(ready);
  files.resourceChat.mockReset().mockResolvedValue(CHAT);
});

describe('reading the bound conversation\'s files', () => {
  it('reads only the bound chat, by the path given, and answers no chat, id, person, message or other App\'s data', async () => {
    const read = await appBindingRead('today', { name: 'main', path: 'today.json' });
    expect(files.read).toHaveBeenCalledExactlyOnceWith(CHAT, 'today.json', 20 * 1024 * 1024);
    expect(read).toEqual({ name: 'main', state: 'ready', content: '{"days":[]}', truncated: false, totalSize: 11, entry: {
      name: 'today.json', path: 'today.json', type: 'json', contentType: 'application/json', size: 12, version: 3,
      createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T01:00:00Z' } });
    const list = await appBindingList('today', { name: 'main', folder: '' });
    expect(files.list).toHaveBeenCalledExactlyOnceWith(CHAT, '');
    // A row of any other chat, whatever answered it, is not this conversation's file.
    expect(list).toMatchObject({ state: 'ready', entries: [{ name: 'today.json' }] });
    expect((list as { entries: unknown[] }).entries).toHaveLength(1);
    for (const said of [JSON.stringify(read), JSON.stringify(list)]) {
      for (const secret of [CHAT, ELSEWHERE, OWNER, OTHER, '66000000', '77000000', 'Someone', 'secret', 'other-app', 'MBP', 'h1']) expect(said).not.toContain(secret);
    }
  });

  it('says missing, unprepared and unavailable apart — never an empty list or empty text for a failure', async () => {
    for (const outcome of ['missing', 'unprepared', 'unavailable'] as const) {
      files.read.mockResolvedValueOnce({ state: outcome });
      expect(await appBindingRead('today', { name: 'main', path: 'today.json' })).toEqual({ name: 'main', state: outcome });
    }
    files.read.mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'failed' }));
    expect(await appBindingRead('today', { name: 'main', path: 'today.json' })).toEqual({ name: 'main', state: 'unavailable' });
    files.list.mockRejectedValueOnce(Object.assign(new Error('no such folder'), { code: 'not-found' }));
    expect(await appBindingList('today', { name: 'main', folder: 'notes' })).toEqual({ name: 'main', state: 'missing' });
    files.list.mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'failed' }));
    expect(await appBindingList('today', { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
    // Membership that could not be verified is not a verified empty folder.
    state.memberError = true;
    expect(await appBindingList('today', { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' });
    expect(await appBindingRead('today', { name: 'main', path: 'today.json' })).toEqual({ name: 'main', state: 'unavailable' });
  });

  it('no conversation chosen yet is unbound, and nothing is read', async () => {
    state.selectedBy = '';
    expect(await appBindingList('today', { name: 'main' })).toEqual({ name: 'main', state: 'unbound' });
    expect(await appBindingRead('today', { name: 'main', path: 'today.json' })).toEqual({ name: 'main', state: 'unbound' });
    expect(reached()).toBe(0);
  });

  it('refuses a supplied chat, owner, handle or id, and an undeclared binding name', async () => {
    for (const extra of [{ chat: CHAT }, { chatId: CHAT }, { ownerId: OWNER }, { handle: 'h1' }, { id: CHAT }, { place: { chat: CHAT } }]) {
      await expect(appBindingRead('today', { name: 'main', path: 'today.json', ...extra })).rejects.toMatchObject({ code: 'invalid' });
      await expect(appBindingList('today', { name: 'main', ...extra })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(appBindingRead('today', { name: 7, path: 'today.json' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(appBindingRead('today', { name: 'other', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
    expect(reached()).toBe(0);
  });

  it.each([
    '../today.json', '/today.json', 'notes/../../x', 'notes/./today.json', './today.json', 'notes//today.json', 'notes/', 'a\\b',
    'today.json\u0000', 'line\nbreak', ' today.json', CHAT, `${CHAT}/today.json`, '', 'x'.repeat(1025),
  ])('refuses the path %j before anything is asked', async (path) => {
    await expect(appBindingRead('today', { name: 'main', path })).rejects.toMatchObject({ code: 'invalid' });
    if (path !== '') await expect(appBindingList('today', { name: 'main', folder: path })).rejects.toMatchObject({ code: 'invalid' });
    expect(reached()).toBe(0);
  });

  it('refuses non-string paths and folders, such as a chat file reference', async () => {
    for (const path of [{ chat: CHAT, name: 'today.json' }, ['today.json'], 1, null]) {
      await expect(appBindingRead('today', { name: 'main', path })).rejects.toMatchObject({ code: 'invalid' });
      await expect(appBindingList('today', { name: 'main', folder: path })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(reached()).toBe(0);
  });

  it('a stale or replaced handle, mid-request, is refused and its content withheld', async () => {
    files.read.mockImplementationOnce(async () => { state.handle = 'h2'; return ready; });
    await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
    state.handle = 'h1';
    state.afterMember = () => { state.handle = 'h3'; };
    await expect(appBindingList('today', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    expect(files.list).not.toHaveBeenCalled();
  });

  it('another account\'s selection reaches nothing, and an account switch mid-request is refused', async () => {
    state.owner = OTHER;
    expect(await appBindingRead('today', { name: 'main', path: 'today.json' })).toEqual({ name: 'main', state: 'unbound' });
    expect(reached()).toBe(0);
    state.owner = OWNER;
    files.read.mockImplementationOnce(async () => { state.owner = OTHER; return ready; });
    await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
    state.owner = OWNER;
    // Signed out while the folder was read.
    files.list.mockImplementationOnce(async () => { state.owner = ''; return [entry('today.json')]; });
    await expect(appBindingList('today', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('a grant withdrawn, an App disabled or uninstalled mid-request: refused, and the content withheld', async () => {
    for (const withdraw of [() => { state.grants.files = false; }, () => { state.enabled = false; }, () => { state.installed = false; }]) {
      Object.assign(state, { installed: true, enabled: true, grants: { files: true, draft: true } });
      files.read.mockImplementationOnce(async () => { withdraw(); return ready; });
      await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
      Object.assign(state, { installed: true, enabled: true, grants: { files: true, draft: true } });
      files.list.mockImplementationOnce(async () => { withdraw(); return [entry('today.json')]; });
      await expect(appBindingList('today', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    }
  });

  it('without the grant, disabled, uninstalled or no longer a member: refused before any file is asked', async () => {
    for (const set of [() => { state.grants.files = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.member = false; }]) {
      Object.assign(state, { installed: true, enabled: true, member: true, grants: { files: true, draft: true } });
      set();
      await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
      await expect(appBindingList('today', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    }
    expect(reached()).toBe(0);
    // The folder's own door refusing the account is a refusal, not a missing file.
    Object.assign(state, { member: true });
    files.read.mockRejectedValueOnce(Object.assign(new Error('not a member'), { code: 'denied' }));
    await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('a topic keeps no folder of its own: its source chat\'s files are not read through it', async () => {
    files.resourceChat.mockResolvedValue(ELSEWHERE);
    await expect(appBindingRead('today', { name: 'main', path: 'today.json' })).rejects.toMatchObject({ code: 'denied' });
    await expect(appBindingList('today', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    expect(reached()).toBe(0);
  });
});

describe('a draft into the bound conversation', () => {
  const draft = { text: '  What is first today?  ', draft: true, to: { binding: 'main' } };

  it('goes only into the bound conversation\'s composer, sends nothing, and answers the binding, not the chat', async () => {
    const draftInChat = vi.fn(async () => undefined);
    const answer = await draftIntoBoundConversation('today', draft, draftInChat);
    expect(draftInChat).toHaveBeenCalledExactlyOnceWith({ chatId: CHAT, text: 'What is first today?\n' });
    expect(answer).toEqual({ to: { binding: 'main' } });
    expect(JSON.stringify(answer)).not.toContain(CHAT);
  });

  it('is refused unbound, without the grant, after a withdrawal or account switch mid-request, and without membership', async () => {
    const draftInChat = vi.fn(async () => undefined);
    state.selectedBy = '';
    await expect(draftIntoBoundConversation('today', draft, draftInChat)).rejects.toMatchObject({ code: 'not-found' });
    for (const set of [
      () => { state.grants.draft = false; },
      () => { state.afterMember = () => { state.grants.draft = false; }; },
      () => { state.afterMember = () => { state.enabled = false; }; },
      () => { state.afterMember = () => { state.installed = false; }; },
      () => { state.afterMember = () => { state.owner = OTHER; }; },
      () => { state.afterMember = () => { state.handle = 'h2'; }; },
      () => { state.member = false; },
    ]) {
      Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, grants: { files: true, draft: true }, afterMember: undefined });
      set();
      await expect(draftIntoBoundConversation('today', draft, draftInChat)).rejects.toMatchObject({ code: 'denied' });
    }
    // The files grant alone does not put a draft anywhere.
    Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, grants: { files: true, draft: false }, afterMember: undefined });
    await expect(draftIntoBoundConversation('today', draft, draftInChat)).rejects.toMatchObject({ code: 'denied' });
    expect(draftInChat).not.toHaveBeenCalled();
  });

  it('is a draft only, text only, naming the binding alone', async () => {
    const draftInChat = vi.fn(async () => undefined);
    for (const args of [
      { text: 'x', to: { binding: 'main' } },
      { text: 'x', draft: true, to: { binding: 'main', chat: CHAT } },
      { text: 'x', draft: true, to: { binding: 'Main!' } },
      { text: 'x', draft: true, to: { binding: 'main' }, refs: [{ file: { chat: CHAT, id: CHAT } }] },
      { text: 'x', draft: true, to: { binding: 'main' }, images: [] },
      { text: 'x', draft: true, to: { binding: 'main' }, visible: true },
      { text: '', draft: true, to: { binding: 'main' } },
    ]) await expect(draftIntoBoundConversation('today', args, draftInChat)).rejects.toMatchObject({ code: 'invalid' });
    expect(draftInChat).not.toHaveBeenCalled();
  });
});
