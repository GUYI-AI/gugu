import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppComposeDetail, AppFileEntry } from '@shared/extensions/app-runtime-protocol';

/**
 * #50 A draft into the binding's conversation carrying files (`attach`): one of its folder by path (the binding's `files`)
 * or one of the agent's resources by domain and key (that domain's read grant; the pill links the resource's stored body,
 * a file of the same private conversation). Each found again under the selection the draft goes to; the App hears back
 * the binding only. The grant rules of `boundAgent` are app-bound-resources-grant.test.ts's.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const ELSEWHERE = '55000000-0000-4000-8000-000000000005';
const FILE_ID = '66000000-0000-4000-8000-000000000006';
const BODY_ID = '88000000-0000-4000-8000-000000000008';
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', member: true,
  grants: {} as Record<string, boolean>, domains: [] as string[],
  bodyChat: '', filesChat: '', storeError: null as unknown, afterList: undefined as (() => void) | undefined,
}));
const files = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), resourceChat: vi.fn() }));
const groupFile = vi.hoisted(() => vi.fn());
const items = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token || null }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: files, groupFile }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  conversationBinding: (owner: string, _app: string, name: string, action: string) => {
    if (!state.grants[action] || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: action === 'files' && state.filesChat ? state.filesChat : CHAT, handle: state.handle } : null;
  },
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: state.member ? { chat_id: CHAT } : null, error: null }) };
  return query;
} }) }));
// The resource authority and store, as app-bound-resources.ts answers them; its refusal and reason classes are its own.
vi.mock('./app-bound-resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-bound-resources')>()),
  boundAgent: async (_app: string, name: string, needs: string[], domain: string) => {
    if (needs.join() !== 'resources' || !state.grants.resources || !state.domains.includes(domain) || name !== 'main') throw denied('domain not granted');
    if (state.owner !== state.selectedBy) return null;
    const handle = state.handle;
    return { ownerId: OWNER, token: OWNER, chatId: CHAT, handle, agentId: AGENT, deviceId: 'home', recheck: async () => {
      if (state.owner !== OWNER || state.handle !== handle) throw denied('Conversation binding changed');
    } };
  },
  storeOf: () => ({
    snapshot: async () => {
      if (state.storeError) throw state.storeError;
      return { version: 1, revision: '10', application: [], items: ['memory', 'files', 'skills'].map((domain) => ({
        assistant_user_id: AGENT, owner_user_id: OWNER, domain, resource_key: '__collection__', device_id: null, revision: '1',
        data: { state: 'ready', schemaVersion: 1, itemCount: [...items.values()].filter((item) => item.domain === domain).length },
        body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-11T00:00:00Z' })).concat([...items.values()] as never[]) };
    },
    resource: async (_agent: string, domain: string, key: string) => {
      if (state.storeError) throw state.storeError;
      return items.get(`${domain}\0${key}`) ?? null;
    },
  }),
}));
const { draftIntoBoundConversation } = await import('./app-unread-bindings');

function entry(path: string, patch: Partial<AppFileEntry> = {}): AppFileEntry {
  const name = path.split('/').pop()!;
  return { id: FILE_ID, chat: CHAT, name, savedName: name, contentType: 'text/markdown', type: 'text', parentId: null, path, systemRole: null,
    suffix: '.md', displayName: name, claimedBy: null, appState: false, size: 12, version: 3, createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T01:00:00Z', ...patch } as AppFileEntry;
}
function resource(domain: string, key: string, patch: Record<string, unknown> = {}) {
  items.set(`${domain}\0${key}`, { assistant_user_id: AGENT, owner_user_id: OWNER, domain, resource_key: key, device_id: 'home', revision: '4',
    data: { kind: 'file', path: key }, body_item_id: BODY_ID, body_sha256: 'abc', deleted_at: null, observed_at: null, updated_at: '2026-11-11T00:00:00Z', ...patch });
}
let drafted: AppComposeDetail[];
const draft = (attach: unknown, text = 'Look at these') => draftIntoBoundConversation('assistant', { text, draft: true, to: { binding: 'main' }, attach },
  async (detail) => { drafted.push(detail); });

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', member: true, grants: { draft: true, files: true, resources: true },
    domains: ['memory', 'files', 'voice-notes'], bodyChat: CHAT, filesChat: '', storeError: null, afterList: undefined });
  drafted = [];
  items.clear();
  files.list.mockReset().mockImplementation(async (_chat: string, folder: string) => {
    state.afterList?.();
    return folder === 'notes' ? [entry('notes/plan.md'), entry('notes/sub', { type: 'folder' }), entry('notes/theirs.md', { chat: ELSEWHERE })] : [entry('today.md')];
  });
  files.resourceChat.mockReset().mockResolvedValue(CHAT);
  groupFile.mockReset().mockImplementation(async (_chat: string, itemId: string) => {
    if (itemId !== BODY_ID) throw Object.assign(new Error('No such file in this chat'), { code: 'not-found' });
    return { chatId: state.bodyChat, itemId: BODY_ID, name: 'x.bin', file: { version: 2 } };
  });
  resource('files', 'reports/q3.pdf');
  resource('voice-notes', 'n1/summary.md', { data: { noteId: 'n1', kind: 'summary.md' } });
});

describe('a draft carrying files', () => {
  it('pills of the conversation\'s file and the agent\'s resources, in order, into the composer; the App hears the binding only', async () => {
    const answer = await draft([{ file: 'notes/plan.md' }, { domain: 'files', key: 'reports/q3.pdf' }, { file: 'today.md' }, { domain: 'voice-notes', key: 'n1/summary.md' }]);
    expect(answer).toEqual({ to: { binding: 'main' } });
    expect(drafted).toEqual([{ chatId: CHAT, text: 'Look at these\n', refs: [
      { label: 'plan.md', link: `gugu-file://${FILE_ID}?v=3` },
      { label: 'q3.pdf', link: `gugu-file://${BODY_ID}?v=2` },
      { label: 'today.md', link: `gugu-file://${FILE_ID}?v=3` },
      { label: 'summary.md', link: `gugu-file://${BODY_ID}?v=2` },
    ] }]);
    expect(files.list.mock.calls).toEqual([[CHAT, 'notes'], [CHAT, '']]);
    expect(groupFile).toHaveBeenCalledWith(CHAT, BODY_ID);
  });

  it('files alone, without text', async () => {
    await draft([{ file: 'today.md' }], '');
    expect(drafted).toEqual([{ chatId: CHAT, text: '', refs: [{ label: 'today.md', link: `gugu-file://${FILE_ID}?v=3` }] }]);
  });
});

describe('what a draft may not carry', () => {
  it('a file without the binding\'s files, a resource of a domain not granted: refused, nothing drafted', async () => {
    state.grants.files = false;
    await expect(draft([{ file: 'today.md' }])).rejects.toMatchObject({ code: 'denied' });
    state.grants.files = true;
    state.domains = ['memory'];
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'denied' });
    state.grants.resources = false;
    state.domains = ['memory', 'files'];
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'denied' });
    expect(drafted).toEqual([]);
  });

  it('what is not there is not-found: another chat\'s row, a folder, a removed or unknown resource', async () => {
    for (const attach of [{ file: 'notes/theirs.md' }, { file: 'notes/sub' }, { file: 'notes/none.md' }, { domain: 'files', key: 'none.pdf' }]) {
      await expect(draft([attach])).rejects.toMatchObject({ code: 'not-found' });
    }
    resource('files', 'gone.pdf', { deleted_at: '2026-11-11T00:00:00Z' });
    await expect(draft([{ domain: 'files', key: 'gone.pdf' }])).rejects.toMatchObject({ code: 'not-found' });
    resource('files', 'lost.pdf', { body_item_id: '99000000-0000-4000-8000-000000000009' });
    await expect(draft([{ domain: 'files', key: 'lost.pdf' }])).rejects.toMatchObject({ code: 'not-found' });
    files.list.mockRejectedValueOnce(Object.assign(new Error('no such folder'), { code: 'not-found' }));
    await expect(draft([{ file: 'nowhere/x.md' }])).rejects.toMatchObject({ code: 'not-found' });
    expect(drafted).toEqual([]);
  });

  it('personality and a folder of resources are no file; a body in another conversation is not attached', async () => {
    state.domains = ['memory', 'files', 'personality'];
    await expect(draft([{ domain: 'personality', key: 'instructions' }])).rejects.toMatchObject({ code: 'invalid' });
    resource('files', 'docs', { data: { kind: 'directory', path: 'docs' }, body_item_id: null });
    await expect(draft([{ domain: 'files', key: 'docs' }])).rejects.toMatchObject({ code: 'invalid' });
    state.bodyChat = ELSEWHERE;
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'failed', reason: 'access-unverified' });
    expect(drafted).toEqual([]);
  });

  it('a store that cannot answer is a failure with its class; one that refuses the account a refusal', async () => {
    state.storeError = Object.assign(new Error('slow'), { code: 'read-timeout' });
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'failed', reason: 'timed-out' });
    state.storeError = Object.assign(new Error('no'), { code: '42501' });
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'denied' });
    resource('files', 'old.pdf', { stale_at: '2026-11-11T00:00:00Z' });
    state.storeError = null;
    await expect(draft([{ domain: 'files', key: 'old.pdf' }])).rejects.toMatchObject({ code: 'failed', reason: 'stale' });
    files.list.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'failed' }));
    await expect(draft([{ file: 'today.md' }])).rejects.toMatchObject({ code: 'failed', reason: 'unreadable' });
    expect(drafted).toEqual([]);
  });

  it('the account or the selection changing while files are found: refused, nothing drafted', async () => {
    state.afterList = () => { state.owner = OTHER; };
    await expect(draft([{ file: 'today.md' }, { file: 'notes/plan.md' }])).rejects.toMatchObject({ code: 'denied' });
    // Refused before the next folder is asked for.
    expect(files.list).toHaveBeenCalledTimes(1);
    state.owner = OWNER;
    state.afterList = () => { state.handle = 'h2'; };
    await expect(draft([{ file: 'today.md' }])).rejects.toMatchObject({ code: 'denied' });
    state.handle = 'h1'; state.afterList = undefined;
    groupFile.mockImplementationOnce(async () => { state.handle = 'h3'; return { chatId: CHAT, itemId: BODY_ID, name: 'x.bin', file: { version: 2 } }; });
    await expect(draft([{ domain: 'files', key: 'reports/q3.pdf' }])).rejects.toMatchObject({ code: 'denied' });
    // Files found for another conversation than the one the draft goes to are not its files.
    state.handle = 'h1'; state.filesChat = ELSEWHERE;
    files.resourceChat.mockResolvedValue(ELSEWHERE);
    await expect(draft([{ file: 'today.md' }])).rejects.toMatchObject({ code: 'denied' });
    expect(drafted).toEqual([]);
  });

  it.each([
    ['a path out of the folder', [{ file: '../x.md' }]], ['an id for a path', [{ file: FILE_ID }]], ['a chat beside the file', [{ file: 'today.md', chat: CHAT }]],
    ['an unknown domain', [{ domain: 'schedules', key: 'x' }]], ['an absolute key', [{ domain: 'files', key: '/etc/passwd' }]],
    ['an empty list', []], ['ten files', Array.from({ length: 10 }, () => ({ file: 'today.md' }))], ['a bare string', ['today.md']],
  ])('refuses %s before anything is asked', async (_what, attach) => {
    await expect(draft(attach)).rejects.toMatchObject({ code: 'invalid' });
    expect(files.list).not.toHaveBeenCalled();
    expect(drafted).toEqual([]);
  });

  it('attach goes only with a draft into a binding\'s conversation, and never beside refs or images', async () => {
    const send = (args: Record<string, unknown>) => draftIntoBoundConversation('assistant', { text: 'x', ...args }, async (detail) => { drafted.push(detail); });
    await expect(send({ to: { binding: 'main' }, attach: [{ file: 'today.md' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(send({ draft: true, to: { binding: 'main' }, attach: [{ file: 'today.md' }], refs: [{ file: { chat: CHAT, id: FILE_ID } }] })).rejects.toMatchObject({ code: 'invalid' });
    expect(drafted).toEqual([]);
  });
});
