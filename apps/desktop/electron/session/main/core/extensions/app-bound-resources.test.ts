import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (API 42): an App's reads and changes of the panel resources of the agent its binding's conversation is with. The
 * authority is the signed-in account's own selection for this installed App, the conversation being its private one with
 * an agent it owns, re-checked after every wait; the App names a domain and a key, never an owner, agent, chat or path.
 * The store below keeps the backend contract (docs/assistant-panel-state.md): revisions, `PT409` for a stale one, operation
 * ids that answer their receipt again for the same request and `23505` for another, tombstones that only some domains may
 * bring back (`55000`). The real service's grant rules are in app-bound-resources-grant.test.ts.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const OP = '55000000-0000-4000-8000-000000000005';
const OP2 = '66000000-0000-4000-8000-000000000006';
const ASSISTANT = { agent_user_id: AGENT, member_key: 'assistant', device_id: 'home-device', phase: 'completed', created_at: '2026-11-01T00:00:00Z',
  dm_chat_id: CHAT, agent: { owner_user_id: OWNER, removed_at: null } };
const sha = (text: string) => createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');

type Item = {
  assistant_user_id: string; owner_user_id: string; domain: string; resource_key: string; device_id: string | null; revision: string;
  data: Record<string, unknown>; body_item_id: string | null; body_sha256: string | null; deleted_at: string | null;
  observed_at: string | null; updated_at: string; stale_at?: string | null;
};
const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, member: true,
  grants: {} as Record<string, boolean>, domains: {} as Record<string, string[]>,
  provisions: [] as Record<string, unknown>[], provisionsError: false, provisionFilters: [] as [string, unknown][],
  hooks: {} as Partial<Record<'afterMember' | 'afterSnapshot' | 'afterResource' | 'afterUpload' | 'beforeCommit' | 'afterBody', () => void>>,
  listeners: new Set<(extensionId: string) => void>(),
}));
const store = vi.hoisted(() => ({
  items: new Map<string, Item>(), changes: new Map<string, { hash: string; receipt: Record<string, unknown> }>(), head: 10,
  prepared: new Set<string>(), errored: new Set<string>(), failedApplication: new Set<string>(), down: false, refuse: false,
  commits: [] as Record<string, unknown>[], bodies: new Map<string, Uint8Array>(), uploads: [] as string[], discarded: [] as string[],
  bodyReads: [] as Record<string, unknown>[], commitFails: null as null | { code: string; status: number }, calls: 0,
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const { servingOf } = await vi.hoisted(async () => await import('./test-support/binding-rpc'));
vi.mock('./app-assistant-serving', () => ({
  assistantServingChat: async (_token: string, ownerId: string, chatId: string) => servingOf(state.provisions as never[], ownerId, chatId, state.provisionsError),
}));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token || null }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
vi.mock('./extensions-root', () => {
  const conversationBinding = (owner: string, _app: string, name: string, action: string) => {
    if (!state.installed || !state.enabled || !state.grants.unread || !state.grants[action] || name !== 'main') throw denied('no grant');
    return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle: state.handle } : null;
  };
  return { extensionsService: () => ({
    conversationBinding,
    conversationResourceBinding: (owner: string, app: string, name: string, action: string, domain: string) => {
      const binding = conversationBinding(owner, app, name, action);
      if (!(state.domains[action] ?? []).includes(domain)) throw denied('domain not declared');
      return binding;
    },
    onBindingAuthorityChanged: (listener: (extensionId: string) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  }) };
});
vi.mock('@gugu/core/cloud/assistantPanelBodies', () => ({
  readAssistantPanelBody: async (item: Item, access: Record<string, unknown>) => {
    store.bodyReads.push({ item: item.body_item_id, chatId: access.chatId, ownerId: access.ownerId, maxBytes: access.maxBytes });
    state.hooks.afterBody?.();
    const bytes = store.bodies.get(item.body_item_id!);
    if (!bytes) throw Object.assign(new Error('no bytes'), { code: 'body-unavailable' });
    if (typeof access.maxBytes === 'number' && bytes.byteLength > access.maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large', size: bytes.byteLength });
    return bytes;
  },
  uploadAssistantPanelBody: async (input: { bytes: Uint8Array; chatId: string; ownerId: string }) => {
    if (input.chatId !== CHAT || input.ownerId !== OWNER) throw new Error('wrong folder');
    const itemId = `77000000-0000-4000-8000-${String(store.uploads.length + 1).padStart(12, '0')}`;
    store.uploads.push(itemId); store.bodies.set(itemId, input.bytes.slice());
    state.hooks.afterUpload?.();
    return { itemId, sha256: createHash('sha256').update(input.bytes).digest('hex') };
  },
}));

/** The identity store's panel calls, as the migration answers them; the chat schema's delete; the two reads of the binding. */
function identityRpc(name: string, args: Record<string, unknown>) {
  store.calls += 1;
  if (store.down) return { data: null, error: { message: 'upstream', code: 'PGRST003' }, status: 503 };
  if (store.refuse || args.p_assistant !== AGENT) return { data: null, error: { message: 'Personal assistant is not available to this account', code: '42501' }, status: 403 };
  if (name === 'assistant_panel_snapshot') {
    const items = [...store.items.values()].filter((item) => !item.deleted_at);
    const markers = [...store.prepared, ...store.errored].map((domain) => row(domain, '__collection__', { revision: '1',
      data: store.errored.has(domain) ? { state: 'error', schemaVersion: 1, errorCode: 'PANEL_READ' } : { state: 'ready', schemaVersion: 1, itemCount: items.filter((item) => item.domain === domain).length } }));
    state.hooks.afterSnapshot?.();
    return { data: { version: 1, revision: String(store.head), items: [...items, ...markers], application: [...store.failedApplication].map((domain) => ({
      operationId: OP2, revision: '3', domain, resourceKey: 'x', status: 'failed', errorCode: 'APPLY_FAILED' })) }, error: null, status: 200 };
  }
  if (name === 'assistant_panel_resource') {
    state.hooks.afterResource?.();
    return { data: { version: 1, item: store.items.get(`${args.p_domain}\0${args.p_resource_key}`) ?? null }, error: null, status: 200 };
  }
  if (name === 'assistant_panel_commit') {
    state.hooks.beforeCommit?.();
    store.commits.push(args);
    if (store.commitFails) return { data: null, error: { message: 'failed', code: store.commitFails.code }, status: store.commitFails.status };
    const hash = JSON.stringify([args.p_assistant, args.p_domain, args.p_resource_key, args.p_expected_revision, args.p_operation, args.p_data, args.p_body_item_id, args.p_body_sha256, args.p_device_id]);
    const seen = store.changes.get(String(args.p_operation_id));
    if (seen) return seen.hash === hash ? { data: seen.receipt, error: null, status: 200 } : { data: null, error: { message: 'reused', code: '23505' }, status: 409 };
    const key = `${args.p_domain}\0${args.p_resource_key}`;
    const old = store.items.get(key);
    if ((old?.revision ?? '0') !== args.p_expected_revision) return { data: null, error: { message: 'stale', code: 'PT409' }, status: 409 };
    if (old?.deleted_at && args.p_operation !== 'remove' && !(['memory', 'files', 'skills', 'voice-notes'].includes(String(args.p_domain)) && args.p_body_item_id)) {
      return { data: null, error: { message: 'deleted', code: '55000' }, status: 400 };
    }
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
      const answer = async () => {
        if (schema === 'chat' && name === 'workspace_delete_as') {
          store.discarded.push(String(args.p_item_id));
          return { data: null, error: null };
        }
        return identityRpc(name, args);
      };
      const answered = answer();
      return Object.assign(answered, { abortSignal: () => answered });
    },
    from: (table: string) => {
      const query = {
        select: () => query, limit: () => query,
        eq: (column: string, value: unknown) => {
          if (table === 'agent_provisions') state.provisionFilters.push([column, value]);
          return query;
        },
        maybeSingle: async () => {
          state.hooks.afterMember?.();
          return { data: state.member ? { chat_id: CHAT } : null, error: null };
        },
        abortSignal: async () => table === 'agent_provisions'
          ? (state.provisionsError ? { data: null, error: { message: 'down' } } : { data: state.provisions, error: null })
          : { data: null, error: { message: 'unexpected table' } },
      };
      return query;
    },
  }),
}));

function row(domain: string, key: string, patch: Partial<Item> = {}): Item {
  return { assistant_user_id: AGENT, owner_user_id: OWNER, domain, resource_key: key, device_id: 'home-device', revision: '1', data: {},
    body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-11T01:00:00Z', ...patch };
}
function put(domain: string, key: string, text: string, data: Record<string, unknown>, revision = '4') {
  const id = `88000000-0000-4000-8000-${String(store.bodies.size + 1).padStart(12, '0')}`;
  store.bodies.set(id, new TextEncoder().encode(text));
  store.items.set(`${domain}\0${key}`, row(domain, key, { revision, data, body_item_id: id, body_sha256: sha(text) }));
}

const { appResourceList, appResourceRead, appResourceSave, appResourceRemove, appResourceWatch } = await import('./app-bound-resources');
const { addResourceWatch, heldResourceWatches, notifyAgentResourcesChanged, stopResourceWatches } = await import('./app-resource-watches');

const read = (domain: string, key: string) => appResourceRead('assistant', { name: 'main', domain, key });
const list = (domain: string) => appResourceList('assistant', { name: 'main', domain });
const save = (key: string, content: string, expectedRevision: string, operationId = OP, domain = 'memory') =>
  appResourceSave('assistant', { name: 'main', domain, key, operationId, expectedRevision, content });

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, member: true, provisionsError: false, hooks: {},
    grants: { unread: true, resources: true, 'resources:write': true },
    domains: { resources: ['memory', 'files', 'personality', 'skills', 'voice-notes'], 'resources:write': ['memory', 'files', 'personality', 'skills'] },
    provisions: [ASSISTANT], provisionFilters: [] });
  state.listeners.clear();
  Object.assign(store, { head: 10, down: false, refuse: false, commitFails: null, calls: 0 });
  for (const collection of [store.items, store.changes, store.bodies, store.prepared, store.errored, store.failedApplication]) collection.clear();
  for (const recorded of [store.commits, store.uploads, store.discarded, store.bodyReads]) recorded.length = 0;
  for (const domain of ['memory', 'files', 'personality', 'skills']) store.prepared.add(domain);
  put('memory', 'owner-profile.md', '# About me\nLikes tea', { relativePath: 'owner-profile.md', title: 'About me', kind: 'user', modifiedAt: '2026-11-10T00:00:00Z' });
  store.items.set('personality\0instructions', row('personality', 'instructions', { revision: '2', data: { text: 'Be brief.' } }));
});

describe('reading the agent\'s resources', () => {
  it('a domain whole and one resource with its content — no owner, agent, device or body file in the answer', async () => {
    const domain = await list('memory');
    expect(domain).toEqual({ name: 'main', domain: 'memory', state: 'ready', revision: '10', resources: [{
      key: 'owner-profile.md', revision: '4', updatedAt: '2026-11-11T01:00:00Z',
      data: { relativePath: 'owner-profile.md', title: 'About me', kind: 'user', modifiedAt: '2026-11-10T00:00:00Z' } }] });
    const note = await read('memory', 'owner-profile.md');
    expect(note).toMatchObject({ state: 'ready', content: '# About me\nLikes tea', truncated: false, totalSize: 20, resource: { key: 'owner-profile.md', revision: '4' } });
    // The body is read from the bound conversation's private folder, as the account, bounded.
    expect(store.bodyReads).toEqual([{ item: expect.any(String), chatId: CHAT, ownerId: OWNER, maxBytes: 20 * 1024 * 1024 }]);
    expect(await read('personality', 'instructions')).toMatchObject({ state: 'ready', content: 'Be brief.', resource: { data: { text: 'Be brief.' } } });
    for (const said of [JSON.stringify(domain), JSON.stringify(note)]) {
      for (const secret of [OWNER, AGENT, CHAT, 'home-device', '88000000', 'h1', sha('# About me\nLikes tea')]) expect(said).not.toContain(secret);
    }
  });

  it('says missing (with what creating expects), deleted, unprepared and unavailable apart — never an empty list for a failure', async () => {
    expect(await read('memory', 'nothing.md')).toEqual({ name: 'main', domain: 'memory', key: 'nothing.md', state: 'missing', revision: '0' });
    store.items.set('memory\0gone.md', row('memory', 'gone.md', { revision: '9', deleted_at: '2026-11-11T00:00:00Z' }));
    expect(await read('memory', 'gone.md')).toMatchObject({ state: 'missing', revision: '9', deleted: true });
    // A body not stored yet.
    store.items.set('memory\0new.md', row('memory', 'new.md', { revision: '3', body_item_id: '99000000-0000-4000-8000-000000000009', body_sha256: sha('x') }));
    expect(await read('memory', 'new.md')).toMatchObject({ state: 'unprepared' });
    store.items.set('memory\0bare.md', row('memory', 'bare.md', { revision: '3' }));
    expect(await read('memory', 'bare.md')).toMatchObject({ state: 'unprepared' });
    // Not published yet: no collection marker is not an empty domain.
    expect(await list('skills')).toMatchObject({ state: 'ready', resources: [] });
    store.prepared.delete('skills');
    expect(await list('skills')).toEqual({ name: 'main', domain: 'skills', state: 'unprepared' });
    // A failed publication, a change that failed to apply, an out-of-date observation, a store that did not answer.
    store.errored.add('files'); store.prepared.delete('files');
    expect(await list('files')).toEqual({ name: 'main', domain: 'files', state: 'unavailable', reason: 'unreadable' });
    store.failedApplication.add('memory');
    expect(await list('memory')).toEqual({ name: 'main', domain: 'memory', state: 'unavailable', reason: 'not-applied' });
    // As on the assistant's own pages (assistantPanelFiles `collection`): one failed change makes every resource of the
    // domain unreadable, not just that one; other domains read on.
    // 50: each with the class the pages tell the person, nothing more.
    expect(await read('memory', 'owner-profile.md')).toEqual({ name: 'main', domain: 'memory', key: 'owner-profile.md', state: 'unavailable', reason: 'not-applied' });
    expect(await read('personality', 'instructions')).toMatchObject({ state: 'ready' });
    store.failedApplication.clear();
    // A resource of a domain not yet published is not read either.
    store.prepared.delete('skills');
    expect(await read('skills', 'writing')).toMatchObject({ state: 'unprepared' });
    store.prepared.add('skills');
    store.items.set('memory\0old.md', row('memory', 'old.md', { stale_at: '2026-11-11T00:00:00Z' }));
    expect(await list('memory')).toMatchObject({ state: 'unavailable', reason: 'stale' });
    expect(await read('memory', 'old.md')).toMatchObject({ state: 'unavailable', reason: 'stale' });
    store.down = true;
    expect(await list('personality')).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
    expect(await read('memory', 'owner-profile.md')).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
    store.down = false;
    // Membership or the agent that could not be verified is not a verified empty domain.
    state.provisionsError = true;
    expect(await list('memory')).toEqual({ name: 'main', domain: 'memory', state: 'unavailable', reason: 'owner-unknown' });
  });

  it('too large: its size alone; not text: binary; a voice-note list published in part is still read', async () => {
    put('files', 'big.txt', 'a'.repeat(32), { name: 'big.txt', path: 'big.txt', kind: 'file' });
    store.bodies.set(store.items.get('files\0big.txt')!.body_item_id!, new Uint8Array(20 * 1024 * 1024 + 1));
    expect(await read('files', 'big.txt')).toMatchObject({ state: 'ready', content: '', truncated: true, totalSize: 20 * 1024 * 1024 + 1 });
    put('files', 'photo.png', 'x', { name: 'photo.png', path: 'photo.png', kind: 'file' });
    store.bodies.set(store.items.get('files\0photo.png')!.body_item_id!, new Uint8Array([0x89, 0xff, 0xfe]));
    expect(await read('files', 'photo.png')).toMatchObject({ state: 'ready', content: '', binary: true, totalSize: 3 });
    put('voice-notes', 'n1/transcript.md', 'hello', { noteId: 'n1', kind: 'transcript.md' });
    expect(await list('voice-notes')).toMatchObject({ state: 'ready', resources: [{ key: 'n1/transcript.md', data: { noteId: 'n1', kind: 'transcript.md' } }] });
    // A voice note is read on its own whatever its list says, as the assistant's pages read one (`find(path, false)`).
    store.failedApplication.add('voice-notes');
    expect(await list('voice-notes')).toMatchObject({ state: 'unavailable' });
    expect(await read('voice-notes', 'n1/transcript.md')).toMatchObject({ state: 'ready', content: 'hello' });
  });

  it('no conversation chosen: unbound, and nothing is read', async () => {
    state.selectedBy = '';
    expect(await list('memory')).toEqual({ name: 'main', domain: 'memory', state: 'unbound' });
    expect(await read('memory', 'owner-profile.md')).toMatchObject({ state: 'unbound' });
    expect(await save('a.md', 'x', '0')).toMatchObject({ state: 'unbound' });
    expect(store.bodyReads).toEqual([]);
    expect(store.commits).toEqual([]);
  });

  it('refuses a supplied owner, agent, chat, handle or path, an unknown domain, and malformed keys before anything is asked', async () => {
    for (const extra of [{ ownerId: OWNER }, { agentId: AGENT }, { chatId: CHAT }, { handle: 'h1' }, { path: '/etc/passwd' }]) {
      await expect(appResourceList('assistant', { name: 'main', domain: 'memory', ...extra })).rejects.toMatchObject({ code: 'invalid' });
      await expect(appResourceRead('assistant', { name: 'main', domain: 'memory', key: 'a.md', ...extra })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(list('passwords')).rejects.toMatchObject({ code: 'invalid' });
    for (const key of ['../x.md', '/abs.md', 'a//b.md', 'a\\b.md', 'C:x', '%2e%2e', '__collection__', 'line\nbreak', ' a.md', '', 'x'.repeat(513), 7]) {
      await expect(read('memory', key as string)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(read('personality', 'other')).rejects.toMatchObject({ code: 'invalid' });
    expect(store.bodyReads).toEqual([]);
  });

  it('a domain this App did not list, or one never granted, is refused; so is the bound conversation not being with an own agent', async () => {
    state.domains.resources = ['memory'];
    await expect(list('files')).rejects.toMatchObject({ code: 'denied' });
    for (const domain of ['integrations', 'tasks', 'schedules', 'capabilities', 'device-notes']) await expect(list(domain)).rejects.toMatchObject({ code: 'denied' });
    // Whatever a grant were to say: connections and the rest are never an App's.
    state.domains = { resources: ['memory', 'integrations', 'device-notes'], 'resources:write': ['integrations'] };
    for (const domain of ['integrations', 'device-notes']) {
      await expect(list(domain)).rejects.toMatchObject({ code: 'denied' });
      await expect(read(domain, 'k')).rejects.toMatchObject({ code: 'denied' });
    }
    await expect(save('k', 'x', '0', OP, 'integrations')).rejects.toMatchObject({ code: 'denied' });
    state.domains.resources = ['memory', 'files'];
    // Someone else's agent, a group or a person (no personal assistant of the account names this conversation), a removed
    // or cancelled one.
    for (const provisions of [[], [{ ...ASSISTANT, agent: { owner_user_id: OTHER, removed_at: null } }],
      [{ ...ASSISTANT, agent: { owner_user_id: OWNER, removed_at: '2026-11-01T00:00:00Z' } }], [{ ...ASSISTANT, phase: 'cancelled' }],
      [{ ...ASSISTANT, dm_chat_id: OTHER }]]) {
      state.provisions = provisions;
      await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
      await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
      await expect(save('a.md', 'x', '0')).rejects.toMatchObject({ code: 'denied' });
    }
    expect(store.commits).toEqual([]);
    // The store refusing this account for that agent anyway is a refusal, not unavailable.
    state.provisions = [ASSISTANT];
    store.refuse = true;
    await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
    expect(store.commits).toEqual([]);
  });

  it('only the person\'s personal assistant: another of their own agents is refused here, before the store is asked', async () => {
    const asked = () => store.calls + store.bodyReads.length + store.uploads.length;
    // Another agent of the same person, its own private conversation chosen (not the assistant: the store has no panel for it).
    const researcher = { ...ASSISTANT, member_key: 'researcher' };
    // An older assistant superseded by a newer one (the one the assistant's pages show).
    const superseded = [{ ...ASSISTANT, created_at: '2026-10-01T00:00:00Z' },
      { ...ASSISTANT, agent_user_id: OTHER, dm_chat_id: OTHER, created_at: '2026-11-05T00:00:00Z' }];
    for (const provisions of [[researcher], superseded]) {
      state.provisions = provisions;
      await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
      await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
      await expect(save('a.md', 'x', '0')).rejects.toMatchObject({ code: 'denied' });
      await expect(appResourceWatch('assistant', 51, { watchId: '1', name: 'main', on: true }, () => undefined)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(asked()).toBe(0);
    // The same assistant, completed once and being set up again, is still served.
    state.provisions = [ASSISTANT, { ...ASSISTANT, phase: 'provisioning', created_at: '2026-11-09T00:00:00Z' }];
    expect(await list('memory')).toMatchObject({ state: 'ready' });
    // A binding that cannot be read is not a refusal: unavailable, not denied.
    state.provisionsError = true;
    expect(await list('memory')).toMatchObject({ state: 'unavailable' });
  });

  it('a forged or replaced selection mid-request is refused and the content withheld', async () => {
    state.hooks.afterResource = () => { state.handle = 'h2'; };
    await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
    // Refused before its content is fetched at all.
    expect(store.bodyReads).toEqual([]);
    state.handle = 'h1'; state.hooks = { afterMember: () => { state.handle = 'h3'; } };
    await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
    state.handle = 'h1'; state.hooks = { afterBody: () => { state.handle = 'h4'; } };
    await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
  });

  it('another account\'s selection reaches nothing; an account switch or sign-out mid-request is refused', async () => {
    state.owner = OTHER;
    expect(await list('memory')).toMatchObject({ state: 'unbound' });
    state.owner = OWNER;
    state.hooks.afterSnapshot = () => { state.owner = OTHER; };
    await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
    state.owner = OWNER; state.hooks = { afterBody: () => { state.owner = ''; } };
    await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
    state.owner = '';
    await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
  });

  it('a grant withdrawn, the App disabled or uninstalled mid-request: refused, content withheld', async () => {
    for (const withdraw of [() => { state.grants.resources = false; }, () => { state.grants.unread = false; }, () => { state.enabled = false; }, () => { state.installed = false; }]) {
      Object.assign(state, { installed: true, enabled: true, grants: { unread: true, resources: true, 'resources:write': true } });
      state.hooks = { afterSnapshot: withdraw };
      await expect(list('memory')).rejects.toMatchObject({ code: 'denied' });
      Object.assign(state, { installed: true, enabled: true, grants: { unread: true, resources: true, 'resources:write': true } });
      state.hooks = { afterBody: withdraw };
      await expect(read('memory', 'owner-profile.md')).rejects.toMatchObject({ code: 'denied' });
    }
  });
});

describe('changing the agent\'s resources', () => {
  it('a save or a removal is refused: nothing is uploaded or committed, whatever was granted', async () => {
    await expect(save('notes/a.md', 'hello', '0')).rejects.toMatchObject({ code: 'denied' });
    await expect(appResourceRemove('assistant', { name: 'main', domain: 'memory', key: 'owner-profile.md', operationId: OP2, expectedRevision: '4' }))
      .rejects.toMatchObject({ code: 'denied' });
    expect(store.commits).toEqual([]);
    expect(store.uploads).toEqual([]);
  });
});

describe('hearing that the agent\'s resources changed', () => {
  const watch = async (watchId: string, pageId = 41) => {
    const heard: unknown[] = [];
    const answer = await appResourceWatch('assistant', pageId, { watchId, name: 'main', on: true }, (id, event) => heard.push([id, event]));
    return { answer, heard };
  };
  beforeEach(() => stopResourceWatches(41));

  it('a watch hears its agent\'s changes, not another agent\'s; stopped, it hears nothing', async () => {
    const { answer, heard } = await watch('1');
    expect(answer).toEqual({ name: 'main', state: 'watching' });
    await notifyAgentResourcesChanged([AGENT]);
    await notifyAgentResourcesChanged(['99000000-0000-4000-8000-000000000009']);
    expect(heard).toEqual([['1', { name: 'main', state: 'changed' }]]);
    await appResourceWatch('assistant', 41, { watchId: '1', name: 'main', on: false }, () => undefined);
    await notifyAgentResourcesChanged('all');
    expect(heard).toHaveLength(1);
    expect(heldResourceWatches()).toBe(0);
  });

  it('torn down when the grant is withdrawn, the App disabled or uninstalled, or another conversation chosen — the page hears ended', async () => {
    for (const withdraw of [() => { state.grants.resources = false; }, () => { state.enabled = false; }, () => { state.installed = false; }, () => { state.handle = 'h2'; }]) {
      Object.assign(state, { handle: 'h1', installed: true, enabled: true, grants: { unread: true, resources: true, 'resources:write': true } });
      const { heard } = await watch('2');
      expect(state.listeners.size).toBe(1);
      withdraw();
      for (const listener of state.listeners) listener('assistant');
      await vi.waitFor(() => expect(heard).toEqual([['2', { name: 'main', state: 'ended' }]]));
      expect(heldResourceWatches()).toBe(0);
      // Nothing more reaches it, and the service is no longer listened to.
      await notifyAgentResourcesChanged('all');
      expect(heard).toHaveLength(1);
      expect(state.listeners.size).toBe(0);
    }
  });

  it('torn down on sign-out or an account switch; never started unbound, without the grant or for another account\'s agent', async () => {
    const { heard } = await watch('3');
    state.owner = OTHER;
    await notifyAgentResourcesChanged('all');
    expect(heard).toEqual([['3', { name: 'main', state: 'ended' }]]);
    state.owner = OWNER;
    const second = await watch('4');
    state.owner = '';
    await notifyAgentResourcesChanged([AGENT]);
    expect(second.heard).toEqual([['4', { name: 'main', state: 'ended' }]]);
    state.owner = OWNER; state.selectedBy = '';
    expect((await watch('5')).answer).toEqual({ name: 'main', state: 'unbound' });
    state.selectedBy = OWNER; state.grants.resources = false;
    await expect(watch('6')).rejects.toMatchObject({ code: 'denied' });
    state.grants.resources = true; state.provisions = [];
    await expect(watch('7')).rejects.toMatchObject({ code: 'denied' });
    state.provisions = [{ ...ASSISTANT, member_key: 'researcher' }];
    await expect(watch('8')).rejects.toMatchObject({ code: 'denied' });
    expect(heldResourceWatches()).toBe(0);
  });

  it('a grant withdrawn between the last check and holding the watch: not held', async () => {
    const hear = vi.fn();
    state.handle = 'h5';
    expect(addResourceWatch({ pageId: 41, watchId: '8', extensionId: 'assistant', name: 'main', ownerId: OWNER, handle: 'h1', agentId: AGENT, hear })).toBe(false);
    expect(heldResourceWatches()).toBe(0);
    expect(state.listeners.size).toBe(0);
    expect(hear).not.toHaveBeenCalled();
  });
});
