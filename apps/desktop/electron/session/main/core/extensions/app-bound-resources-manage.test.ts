import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #50 An App managing what the person's assistant keeps, as the assistant's 记忆 pages do: 给助理的资料 (upload through the
 * host's picker, new folder, rename, folder delete) and voice notes (开始转写, delete, export). Every call goes through the
 * pages' own store view (`createAssistantPanelFiles`) as the person, under the binding's authority, checked again after
 * each wait — the assistant at home on this computer or another alike: the change names the assistant's home device and
 * the store carries it there. The store below keeps the backend contract (app-bound-resources.test.ts); the window's half
 * (the question, the pipeline, the save dialog) is app-resource-window-core.test.ts's.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const NOTE = 'n-20261110-0900';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Item = {
  assistant_user_id: string; owner_user_id: string; domain: string; resource_key: string; device_id: string | null; revision: string;
  data: Record<string, unknown>; body_item_id: string | null; body_sha256: string | null; deleted_at: string | null;
  observed_at: string | null; updated_at: string; stale_at?: string | null;
};
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, member: true, memberError: false, apiVersion: 50, home: '',
  grants: {} as Record<string, boolean>, domains: {} as Record<string, string[]>,
  provisions: [] as Record<string, unknown>[], provisionsError: false,
}));
const store = vi.hoisted(() => ({
  items: new Map<string, Item>(), changes: new Map<string, { hash: string; receipt: Record<string, unknown> }>(), head: 10,
  prepared: new Set<string>(), failedApplication: new Set<string>(), down: false, refuse: false, timeout: false,
  commits: [] as Record<string, unknown>[], bodies: new Map<string, Uint8Array>(), uploads: [] as string[], discarded: [] as string[],
  commitFails: null as null | { code: string; status: number },
}));
const host = vi.hoisted(() => ({ pickFiles: vi.fn(), confirmRemoval: vi.fn(), transcribe: vi.fn(), exportNote: vi.fn() }));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token || null }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {}, groupFile: vi.fn() }));
vi.mock('./app-bound-resources-host', () => ({ manageHost: host }));
vi.mock('./extensions-root', () => {
  const conversationBinding = (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.grants[action] || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  };
  return { extensionsService: () => ({
    get: () => ({ manifest: { apiVersion: state.apiVersion } }),
    conversationBinding,
    conversationResourceBinding: (owner: string, app: string, name: string, action: string, domain: string) => {
      const binding = conversationBinding(owner, app, name, action);
      if (!(state.domains[action] ?? []).includes(domain)) throw denied('domain not declared');
      return binding;
    },
  }) };
});
vi.mock('@gugu/core/cloud/assistantPanelBodies', () => ({
  readAssistantPanelBody: async (item: Item, access: { chatId: string; ownerId: string }) => {
    if (access.chatId !== CHAT || access.ownerId !== OWNER) throw new Error('wrong folder');
    const bytes = store.bodies.get(item.body_item_id!);
    if (!bytes) throw Object.assign(new Error('no bytes'), { code: 'body-unavailable' });
    return bytes;
  },
  uploadAssistantPanelBody: async (input: { bytes: Uint8Array; chatId: string; ownerId: string }) => {
    if (input.chatId !== CHAT || input.ownerId !== OWNER) throw new Error('wrong folder');
    const itemId = `77000000-0000-4000-8000-${String(store.uploads.length + 1).padStart(12, '0')}`;
    store.uploads.push(itemId); store.bodies.set(itemId, input.bytes.slice());
    return { itemId, sha256: sha(input.bytes) };
  },
}));

function identityRpc(name: string, args: Record<string, unknown>) {
  if (store.timeout) return new Promise(() => undefined);
  if (store.down) return { data: null, error: { message: 'upstream', code: 'PGRST003' }, status: 503 };
  if (store.refuse || args.p_assistant !== AGENT) return { data: null, error: { message: 'Personal assistant is not available to this account', code: '42501' }, status: 403 };
  if (name === 'assistant_panel_snapshot') {
    const items = [...store.items.values()].filter((item) => !item.deleted_at);
    const markers = [...store.prepared].map((domain) => row(domain, '__collection__', { revision: '1',
      data: { state: 'ready', schemaVersion: 1, itemCount: items.filter((item) => item.domain === domain).length } }));
    return { data: { version: 1, revision: String(store.head), items: [...items, ...markers], application: [...store.failedApplication].map((domain) => ({
      operationId: '66000000-0000-4000-8000-000000000006', revision: '3', domain, resourceKey: 'x', status: 'failed', errorCode: 'APPLY_FAILED' })) }, error: null, status: 200 };
  }
  if (name === 'assistant_panel_resource') return { data: { version: 1, item: store.items.get(`${args.p_domain}\0${args.p_resource_key}`) ?? null }, error: null, status: 200 };
  if (name === 'assistant_panel_commit') {
    store.commits.push(args);
    if (store.commitFails) return { data: null, error: { message: 'failed', code: store.commitFails.code }, status: store.commitFails.status };
    const hash = JSON.stringify([args.p_domain, args.p_resource_key, args.p_expected_revision, args.p_operation, args.p_data, args.p_body_item_id, args.p_device_id]);
    const seen = store.changes.get(String(args.p_operation_id));
    if (seen) return seen.hash === hash ? { data: seen.receipt, error: null, status: 200 } : { data: null, error: { message: 'reused', code: '23505' }, status: 409 };
    const key = `${args.p_domain}\0${args.p_resource_key}`;
    const old = store.items.get(key);
    if ((old?.revision ?? '0') !== args.p_expected_revision) return { data: null, error: { message: 'stale', code: 'PT409' }, status: 409 };
    const revision = String(++store.head);
    store.items.set(key, args.p_operation === 'remove'
      ? row(String(args.p_domain), String(args.p_resource_key), { revision, data: {}, deleted_at: '2026-11-11T02:00:00Z' })
      : row(String(args.p_domain), String(args.p_resource_key), { revision, data: args.p_data as Record<string, unknown>,
        body_item_id: args.p_body_item_id as string | null, body_sha256: args.p_body_sha256 as string | null }));
    const receipt = { operationId: args.p_operation_id, revision, status: 'pending' };
    store.changes.set(String(args.p_operation_id), { hash, receipt });
    return { data: receipt, error: null, status: 200 };
  }
  return { data: null, error: { message: 'unknown', code: '42883' }, status: 404 };
}
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: ({ schema }: { schema: string }) => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      const answered = (async () => {
        if (schema === 'chat' && name === 'workspace_delete_as') { store.discarded.push(String(args.p_item_id)); return { data: null, error: null }; }
        return identityRpc(name, args);
      })();
      return Object.assign(answered, { abortSignal: () => answered });
    },
    from: (table: string) => {
      const query = {
        select: () => query, limit: () => query, eq: () => query,
        maybeSingle: async () => state.memberError ? { data: null, error: { message: 'down' } } : { data: state.member ? { chat_id: CHAT } : null, error: null },
        abortSignal: async () => table === 'agent_provisions'
          ? (state.provisionsError ? { data: null, error: { message: 'down' } } : { data: state.provisions, error: null })
          : { data: null, error: { message: 'unexpected table' } },
      };
      return query;
    },
  }),
}));

function row(domain: string, key: string, patch: Partial<Item> = {}): Item {
  return { assistant_user_id: AGENT, owner_user_id: OWNER, domain, resource_key: key, device_id: state.home, revision: '1', data: {},
    body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-11T01:00:00Z', ...patch };
}
function put(domain: string, key: string, text: string, data: Record<string, unknown>, revision = '4') {
  const id = `88000000-0000-4000-8000-${String(store.bodies.size + 1).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(text);
  store.bodies.set(id, bytes);
  store.items.set(`${domain}\0${key}`, row(domain, key, { revision, data, body_item_id: id, body_sha256: sha(bytes) }));
}
const file = (path: string, text = 'x') => put('files', path, text, { name: path.split('/').pop(), path, kind: 'file', contentType: 'text/plain', sizeBytes: text.length });
const folder = (path: string) => store.items.set(`files\0${path}`, row('files', path, { data: { name: path.split('/').pop(), path, kind: 'directory' } }));
function note(id: string, status: string, title: string | null = 'Standup') {
  put('voice-notes', `${id}/note.json`, JSON.stringify({ version: 1, id, createdAt: '2026-11-10T09:00:00Z', status, title }), { noteId: id, kind: 'note.json' });
  put('voice-notes', `${id}/summary.md`, '# Standup\nShip it', { noteId: id, kind: 'summary.md' });
  put('voice-notes', `${id}/transcript.md`, '[00:00] Me: ship it', { noteId: id, kind: 'transcript.md' });
}
const live = (domain: string) => [...store.items.values()].filter((item) => item.domain === domain && !item.deleted_at).map((item) => item.resource_key).sort();
const picked = (name: string, text: string, contentType = 'application/pdf', size = text.length) =>
  ({ name, size, contentType, read: async () => new TextEncoder().encode(text) });

const manage = await import('./app-bound-resources-manage');
const PAGE = 7;
const upload = (args: Record<string, unknown> = {}) => manage.appResourceUpload('assistant', PAGE, { name: 'main', ...args });
const createFolder = (key: unknown) => manage.appResourceCreateFolder('assistant', { name: 'main', key });
const rename = (key: unknown, to: unknown) => manage.appResourceRename('assistant', { name: 'main', key, to });
const removeFolder = (key: unknown) => manage.appResourceRemoveFolder('assistant', PAGE, { name: 'main', key });
const transcribe = (key: unknown) => manage.appVoiceNoteTranscribe('assistant', PAGE, { name: 'main', key });
const removeNote = (key: unknown) => manage.appVoiceNoteRemove('assistant', PAGE, { name: 'main', key });
const exportNote = (key: unknown) => manage.appVoiceNoteExport('assistant', PAGE, { name: 'main', key });
const ALL = [() => upload(), () => createFolder('docs'), () => rename('a.txt', 'b.txt'), () => removeFolder('docs'),
  () => transcribe(NOTE), () => removeNote(NOTE), () => exportNote(NOTE)];

function reset(home: string) {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, memberError: false,
    apiVersion: 50, home, provisionsError: false,
    grants: { unread: true, resources: true, 'resources:write': true, 'voice-notes:manage': true },
    domains: { resources: ['memory', 'files', 'voice-notes'], 'resources:write': ['memory', 'files'] },
    provisions: [{ agent_user_id: AGENT, member_key: 'assistant', device_id: home, phase: 'completed', created_at: '2026-11-01T00:00:00Z',
      dm_chat_id: CHAT, agent: { owner_user_id: OWNER, removed_at: null } }] });
  Object.assign(store, { head: 10, down: false, refuse: false, timeout: false, commitFails: null });
  for (const collection of [store.items, store.changes, store.bodies, store.prepared, store.failedApplication]) collection.clear();
  for (const recorded of [store.commits, store.uploads, store.discarded]) recorded.length = 0;
  for (const domain of ['memory', 'files']) store.prepared.add(domain);
  for (const fn of Object.values(host)) fn.mockReset();
  host.confirmRemoval.mockResolvedValue(true);
  host.transcribe.mockResolvedValue('started');
  host.exportNote.mockResolvedValue('saved');
}
beforeEach(() => reset('home-device'));

// The assistant at home on this computer and on another: the same store, the change naming where it is applied.
describe.each([['this computer', 'this-device'], ['another computer', 'other-device']])('with the assistant at home on %s', (_where, home) => {
  beforeEach(() => reset(home));
  const everyCommitGoesHome = () => {
    expect(store.commits.length).toBeGreaterThan(0);
    for (const commit of store.commits) expect(commit).toMatchObject({ p_assistant: AGENT, p_device_id: home });
  };

  it('upload: the host\'s picker, the page\'s rules, each file written as the page writes it; the rest named back', async () => {
    host.pickFiles.mockResolvedValue([picked('brief.pdf', 'pdf bytes'), picked('clip.mp4', 'v', 'video/mp4'),
      picked('big.pdf', 'b', 'application/pdf', 51 * 1024 * 1024), picked('a.zip', 'z', 'application/zip')]);
    const answer = await upload({ folder: 'docs' });
    expect(host.pickFiles).toHaveBeenCalledExactlyOnceWith(PAGE);
    expect(answer).toEqual({ name: 'main', state: 'done',
      uploaded: [{ key: 'docs/brief.pdf', name: 'brief.pdf', receipt: { operationId: expect.any(String), revision: '11', status: 'pending' } }],
      refused: [{ name: 'clip.mp4', why: 'unsupported' }, { name: 'big.pdf', why: 'too-large' }, { name: 'a.zip', why: 'unsupported' }] });
    expect(store.items.get('files\0docs/brief.pdf')).toMatchObject({ data: { name: 'brief.pdf', path: 'docs/brief.pdf', kind: 'file', contentType: 'application/pdf', sizeBytes: 9 } });
    expect(store.uploads).toHaveLength(1);
    everyCommitGoesHome();
  });

  it('new folder, then the same again is exists', async () => {
    expect(await createFolder('docs')).toEqual({ name: 'main', key: 'docs', state: 'committed', receipt: { operationId: expect.any(String), revision: '11', status: 'pending' } });
    expect(store.items.get('files\0docs')).toMatchObject({ data: { name: 'docs', path: 'docs', kind: 'directory' } });
    expect(await createFolder('docs')).toEqual({ name: 'main', key: 'docs', state: 'exists' });
    expect(store.commits).toHaveLength(1);
    everyCommitGoesHome();
  });

  it('rename: a file, a folder with all in it; a taken name is exists, nothing there is missing', async () => {
    file('a.txt'); file('b.txt'); folder('docs'); file('docs/one.md');
    expect(await rename('a.txt', 'c.txt')).toMatchObject({ state: 'committed', renamedTo: 'c.txt', receipts: [{ status: 'pending' }] });
    expect(store.items.get('files\0a.txt')).toMatchObject({ data: { path: 'c.txt', name: 'c.txt' } });
    expect(await rename('docs', 'papers')).toMatchObject({ state: 'committed', renamedTo: 'papers', receipts: [{}, {}] });
    expect(store.items.get('files\0docs/one.md')).toMatchObject({ data: { path: 'papers/one.md' } });
    const before = store.commits.length;
    expect(await rename('b.txt', 'c.txt')).toEqual({ name: 'main', key: 'b.txt', state: 'exists' });
    expect(await rename('nothing.txt', 'd.txt')).toEqual({ name: 'main', key: 'nothing.txt', state: 'missing' });
    expect(store.commits).toHaveLength(before);
    everyCommitGoesHome();
  });

  it('folder delete: the page\'s question first; yes removes it and all in it, no removes nothing', async () => {
    folder('docs'); file('docs/one.md'); file('docs/deep/two.md'); file('keep.md');
    host.confirmRemoval.mockResolvedValueOnce(false);
    expect(await removeFolder('docs')).toEqual({ name: 'main', key: 'docs', state: 'cancelled' });
    expect(store.commits).toHaveLength(0);
    expect(await removeFolder('docs')).toMatchObject({ state: 'committed', receipts: [{}, {}, {}] });
    expect(host.confirmRemoval).toHaveBeenLastCalledWith(PAGE, { kind: 'folder', name: 'docs' });
    expect(live('files')).toEqual(['keep.md']);
    expect(await removeFolder('docs')).toEqual({ name: 'main', key: 'docs', state: 'missing' });
    await expect(removeFolder('keep.md')).rejects.toMatchObject({ code: 'invalid' });
    everyCommitGoesHome();
  });

  it('开始转写: a note waiting is handed to this window\'s pipeline; anything else is said, not started', async () => {
    note(NOTE, 'uploaded');
    expect(await transcribe(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'started' });
    expect(host.transcribe).toHaveBeenCalledExactlyOnceWith(PAGE, { ownerId: OWNER, assistantId: AGENT, noteId: NOTE });
    for (const outcome of ['busy', 'not-ready'] as const) {
      host.transcribe.mockResolvedValueOnce(outcome);
      expect(await transcribe(NOTE)).toEqual({ name: 'main', key: NOTE, state: outcome });
    }
    host.transcribe.mockResolvedValueOnce('denied');
    await expect(transcribe(NOTE)).rejects.toMatchObject({ code: 'denied' });
    note('n-ready', 'ready');
    expect(await transcribe('n-ready')).toEqual({ name: 'main', key: 'n-ready', state: 'not-waiting' });
    expect(await transcribe('n-none')).toEqual({ name: 'main', key: 'n-none', state: 'missing' });
    expect(host.transcribe).toHaveBeenCalledTimes(4);
    expect(store.commits).toHaveLength(0);
  });

  it('voice note delete: the page\'s question with its title; yes removes all of it', async () => {
    note(NOTE, 'ready'); note('n-keep', 'ready');
    host.confirmRemoval.mockResolvedValueOnce(false);
    expect(await removeNote(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'cancelled' });
    expect(store.commits).toHaveLength(0);
    expect(await removeNote(NOTE)).toMatchObject({ state: 'committed', receipts: [{}, {}, {}] });
    expect(host.confirmRemoval).toHaveBeenLastCalledWith(PAGE, { kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: NOTE });
    expect(live('voice-notes')).toEqual(['n-keep/note.json', 'n-keep/summary.md', 'n-keep/transcript.md']);
    expect(await removeNote(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'missing' });
    everyCommitGoesHome();
  });

  it('export: its title, summary and transcript to the host\'s save dialog', async () => {
    note(NOTE, 'ready');
    expect(await exportNote(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'saved' });
    expect(host.exportNote).toHaveBeenCalledExactlyOnceWith(PAGE, { ownerId: OWNER, title: 'Standup', summary: '# Standup\nShip it', transcript: '[00:00] Me: ship it' });
    host.exportNote.mockResolvedValueOnce('cancelled');
    expect(await exportNote(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'cancelled' });
    host.exportNote.mockResolvedValueOnce('failed');
    await expect(exportNote(NOTE)).rejects.toMatchObject({ code: 'failed' });
    expect(await exportNote('n-none')).toEqual({ name: 'main', key: 'n-none', state: 'missing' });
    expect(store.commits).toHaveLength(0);
  });
});

describe('what an App is told', () => {
  it('keys, names, states and receipts only — no owner, agent, chat, device, handle, body file, store path or link', async () => {
    note(NOTE, 'uploaded'); folder('docs'); file('docs/one.md'); file('a.txt');
    host.pickFiles.mockResolvedValue([picked('brief.pdf', 'pdf'), picked('clip.mp4', 'v', 'video/mp4')]);
    const answers = [await upload(), await createFolder('more'), await rename('a.txt', 'b.txt'), await removeFolder('docs'),
      await transcribe(NOTE), await exportNote(NOTE), await removeNote(NOTE)];
    store.down = true;
    answers.push(await createFolder('again'), await removeNote(NOTE));
    for (const said of answers.map((answer) => JSON.stringify(answer))) {
      for (const secret of [OWNER, AGENT, CHAT, 'home-device', 'h1', '77000000', '88000000', '给助理的资料', '记忆', 'gugu-file:', 'http', '/Users']) {
        expect(said).not.toContain(secret);
      }
    }
    expect(answers.at(-1)).toEqual({ name: 'main', key: NOTE, state: 'unavailable', reason: 'unreadable' });
  });
});

describe('refusals', () => {
  it('nobody chose the conversation: unbound, and nothing is asked of the person or the store', async () => {
    state.selectedBy = '';
    for (const call of ALL) expect(await call()).toMatchObject({ name: 'main', state: 'unbound' });
    expect(Object.values(host).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(store.commits).toHaveLength(0);
  });

  it('an App declaring an API before 50 is refused, whatever it holds', async () => {
    state.apiVersion = 49;
    for (const call of ALL) await expect(call()).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('50') });
  });

  it('files need resources:write listing files; voice notes need voice-notes:manage and voice-notes read', async () => {
    note(NOTE, 'uploaded');
    state.grants['resources:write'] = false;
    for (const call of ALL.slice(0, 4)) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    for (const call of ALL.slice(4)) expect(await call()).not.toHaveProperty('code');
    state.grants['resources:write'] = true;
    state.domains['resources:write'] = ['memory'];
    for (const call of ALL.slice(0, 4)) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    state.domains['resources:write'] = ['memory', 'files'];
    state.grants['voice-notes:manage'] = false;
    for (const call of ALL.slice(4)) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    state.grants['voice-notes:manage'] = true;
    state.domains.resources = ['memory', 'files'];
    for (const call of ALL.slice(4)) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    state.grants.resources = false;
    state.domains.resources = ['memory', 'files', 'voice-notes'];
    for (const call of ALL) await expect(call()).rejects.toMatchObject({ code: 'denied' });
  });

  it('another of the person\'s agents, not in the conversation, or uninstalled: refused before the store', async () => {
    note(NOTE, 'uploaded'); folder('docs');
    state.provisions = [{ ...state.provisions[0], dm_chat_id: OTHER }];
    for (const call of ALL) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    reset('home-device'); note(NOTE, 'uploaded'); folder('docs');
    state.member = false;
    for (const call of ALL) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    reset('home-device');
    state.installed = false;
    for (const call of ALL) await expect(call()).rejects.toMatchObject({ code: 'denied' });
    expect(Object.values(host).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(store.commits).toHaveLength(0);
  });

  it('the account or the selection changing while the person picks or answers: refused, nothing written or removed', async () => {
    folder('docs'); file('docs/one.md'); note(NOTE, 'ready');
    const bytes = vi.fn(async () => new TextEncoder().encode('pdf'));
    host.pickFiles.mockImplementation(async () => { state.owner = OTHER; return [{ ...picked('brief.pdf', 'pdf'), read: bytes }]; });
    await expect(upload()).rejects.toMatchObject({ code: 'denied' });
    // Not a byte of what was picked is read for the account that is gone.
    expect(bytes).not.toHaveBeenCalled();
    expect(store.uploads).toHaveLength(0);
    reset('home-device'); folder('docs'); file('docs/one.md'); note(NOTE, 'ready');
    host.confirmRemoval.mockImplementation(async () => { state.handle = 'h2'; return true; });
    await expect(removeFolder('docs')).rejects.toMatchObject({ code: 'denied' });
    state.handle = 'h1';
    await expect(removeNote(NOTE)).rejects.toMatchObject({ code: 'denied' });
    expect(store.commits).toHaveLength(0);
    state.handle = 'h1';
    host.exportNote.mockImplementation(async () => { state.grants['voice-notes:manage'] = false; return 'saved'; });
    await expect(exportNote(NOTE)).rejects.toMatchObject({ code: 'denied' });
  });

  it.each([
    ['upload folder', () => upload({ folder: '../x' })], ['upload owner', () => upload({ ownerId: OWNER })],
    ['folder ..', () => createFolder('a/../b')], ['folder absolute', () => createFolder('/docs')], ['folder id', () => createFolder(7)],
    ['rename to a path', () => rename('a.txt', 'x/y.txt')], ['rename to ..', () => rename('a.txt', '..')], ['rename chat', () => manage.appResourceRename('assistant', { name: 'main', key: 'a.txt', to: 'b', chatId: CHAT })],
    ['remove ~', () => removeFolder('~/docs')], ['note with /', () => transcribe(`${NOTE}/note.json`)], ['note agent', () => manage.appVoiceNoteExport('assistant', PAGE, { name: 'main', key: NOTE, agentId: AGENT })],
  ])('refuses %s before anything is asked', async (_what, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'invalid' });
    expect(Object.values(host).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(store.commits).toHaveLength(0);
  });

  it('a store that refuses the account is a refusal; one that cannot answer is unavailable with its class', async () => {
    folder('docs'); note(NOTE, 'uploaded');
    store.refuse = true;
    await expect(createFolder('more')).rejects.toMatchObject({ code: 'denied' });
    await expect(transcribe(NOTE)).rejects.toMatchObject({ code: 'denied' });
    store.refuse = false;
    store.failedApplication.add('files');
    expect(await removeFolder('docs')).toEqual({ name: 'main', key: 'docs', state: 'unavailable', reason: 'not-applied' });
    store.failedApplication.clear();
    store.items.set('files\0docs', { ...store.items.get('files\0docs')!, stale_at: '2026-11-11T00:00:00Z' });
    expect(await rename('docs', 'x')).toEqual({ name: 'main', key: 'docs', state: 'unavailable', reason: 'stale' });
    state.provisionsError = true;
    expect(await createFolder('more')).toEqual({ name: 'main', key: 'more', state: 'unavailable', reason: 'owner-unknown' });
    state.provisionsError = false;
    state.memberError = true;
    expect(await exportNote(NOTE)).toEqual({ name: 'main', key: NOTE, state: 'unavailable', reason: 'access-unverified' });
    state.memberError = false;
    store.commitFails = { code: '54000', status: 400 };
    expect(await createFolder('more')).toEqual({ name: 'main', key: 'more', state: 'unavailable', reason: 'too-large' });
  });
});
