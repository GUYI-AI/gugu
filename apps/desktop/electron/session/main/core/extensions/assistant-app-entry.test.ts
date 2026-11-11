import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUGU_APPS_REPO, type MarketCodeSource } from '@shared/extensions/market';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';
import { ExtensionsService } from './extensions-service';
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust } from './test-support/signed-release';

/**
 * Entry switch: the host binds the trusted assistant App (gugu-assistant from gugu's market repository, not a fork) to the
 * account's own assistant chat — no chooser, no consent — keeps it there through setup, a move, close and reopen, follows the
 * account, and never touches the person's own choice. Any other App, the same id from elsewhere included, gets none of it.
 * Real extensions service, manifest and trust check (#1931's, signed releases included: a key made here, trusted by these tests
 * only); the account and the database (provision marker, chat, members) are faked.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '22000000-0000-4000-8000-000000000002';
const DM = '33000000-0000-4000-8000-000000000003';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const DEVICE = '55000000-0000-4000-8000-000000000005';
const STRANGER = '66000000-0000-4000-8000-000000000006';
const GROUP = '77000000-0000-4000-8000-000000000007';
const NEW_DM = '88000000-0000-4000-8000-000000000008';
const NEW_ASSISTANT = '99000000-0000-4000-8000-000000000009';
const OTHER_DM = 'aa000000-0000-4000-8000-00000000000a';
const OTHER_ASSISTANT = 'bb000000-0000-4000-8000-00000000000b';
const ID = 'gugu-assistant';

type Chat = { kind: string; members: string[] };
const db = vi.hoisted(() => ({
  signedIn: '',
  /** owner → their assistant (the provision marker), or none. */
  assistants: {} as Record<string, string | null>,
  chats: {} as Record<string, { kind: string; members: string[] }>,
  down: false,
  afterRead: undefined as (() => void) | undefined,
  service: null as unknown,
}));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => db.signedIn }));
vi.mock('./extensions-root', () => ({ extensionsService: () => db.service }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: ({ schema }: { schema: string }) => ({ from: (table: string) => {
  const filters: Record<string, string> = {};
  const answer = () => {
    db.afterRead?.();
    if (db.down) return { data: null, error: { message: 'down' } };
    if (schema === 'identity') {
      const agent = db.assistants[filters.owner_user_id ?? ''];
      return { data: agent ? [{ agent_user_id: agent, device_id: DEVICE, member_key: 'assistant', phase: 'ready', created_at: '2026-11-01T00:00:00Z', agent: { removed_at: null } }] : [], error: null };
    }
    const chat = db.chats[filters.id ?? filters.chat_id ?? ''];
    if (table === 'chats') return { data: chat ? { kind: chat.kind } : null, error: null };
    return { data: (chat?.members ?? []).map((user_id) => ({ user_id })), error: null };
  };
  const query: Record<string, unknown> = {
    select: () => query,
    eq: (column: string, value: string) => { filters[column] = value; return query; },
    in: () => query,
    maybeSingle: async () => answer(),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(answer).then(resolve, reject),
  };
  return query;
} }) }));
const { syncAssistantAppEntry, assistantAppDistrust } = await import('./assistant-app-entry');
const { assistantRulesTrust } = await import('../../../../assistant-rules-trust');
const KEY = testKey('gugu-assistant-entry-test');
const TRUST = assistantRulesTrust(testTrust(KEY, [ID]));
const distrust = (service: Parameters<typeof assistantAppDistrust>[0]) => assistantAppDistrust(service, TRUST);

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

const official = (version = '0.1.0'): MarketCodeSource => ({ repo: GUGU_APPS_REPO, path: `releases/gugu-assistant/${version}`, commit: 'a'.repeat(40) });
const OFFICIAL = official();
function manifest(id = ID, version = '0.1.0', actions = ['unread', 'surface']) {
  return {
    id, name: 'Assistant', version, apiVersion: 45, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: ['chat:unread', ...actions.includes('surface') ? ['chat:surface'] : [], ...actions.includes('files') ? ['chat:files'] : []],
      bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'today', title: 'Today' }], ...actions.includes('surface') ? { conversationSurface: { binding: 'main', placement: 'side-panel' } } : {} },
  };
}
function host() {
  const root = mkdtempSync(path.join(tmpdir(), 'assistant-app-entry-')); roots.push(root);
  const service = new ExtensionsService(path.join(root, 'installed'));
  db.service = service;
  // A market install from its release folder records the bundle signed as that release, as the market's does (`unsigned`: the
  // source alone, as an install from before releases were checked).
  const install = (value = manifest(), origin: ExtensionOrigin = 'market', source: MarketCodeSource | null = official(value.version), publisher?: { id: string }, unsigned = false) => {
    const dir = path.join(root, `source-${value.id}-${value.version}-${origin}`); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<p>Assistant</p>');
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
    for (const [name, text] of Object.entries(RELEASE_LEGAL_FILES)) writeFileSync(path.join(dir, name), text);
    const release = origin === 'market' && source && !unsigned
      ? signTestRelease({ appDir: dir, appId: value.id, version: value.version, zip: new Uint8Array(), key: KEY }).proof : undefined;
    service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, origin, publisher, undefined, source ? { ...source, ...release ? { release } : {} } : undefined);
  };
  const bound = (owner = OWNER, id = ID) => service.conversationUnreadBinding(owner, id, 'main')?.chatId ?? null;
  return { service, install, bound };
}
const sync = (chatId: string | null, ownerId = OWNER) => syncAssistantAppEntry({ ownerId, chatId }, { distrust });

beforeEach(() => {
  db.signedIn = OWNER;
  db.assistants = { [OWNER]: ASSISTANT };
  db.chats = {
    [DM]: { kind: 'dm', members: [OWNER, ASSISTANT] },
    [GROUP]: { kind: 'group', members: [OWNER, ASSISTANT, STRANGER] },
    [OTHER_DM]: { kind: 'dm', members: [OTHER_OWNER, OTHER_ASSISTANT] },
  } satisfies Record<string, Chat>;
  db.down = false; db.afterRead = undefined;
});

describe('the trusted App: granted and bound by the host, nothing asked', () => {
  it('binds it to the account\'s own assistant chat, every declared permission granted, the conversation drawable beside it', async () => {
    const { service, install, bound } = host();
    install();
    expect(await sync(DM)).toMatchObject({ trusted: true, outcome: 'bound', changed: true, extensionId: ID });
    expect(bound()).toBe(DM);
    expect(service.conversationBinding(OWNER, ID, 'main', 'surface')?.chatId).toBe(DM);
    expect(service.grantedCapabilities(ID)).toEqual(expect.arrayContaining(['chat:unread', 'chat:surface']));
    // Not the person's choice: they can still pick another conversation in the App's permissions.
    expect(service.conversationBindingChosenByPerson(OWNER, ID, 'main')).toBe(false);
    // Again: nothing to do.
    expect(await sync(DM)).toMatchObject({ outcome: 'kept', changed: false });
  });

  it.each([
    ['the same id from a folder', (h: ReturnType<typeof host>) => h.install(manifest(), 'folder', null, { id: STRANGER })],
    ['the same id from another market repository', (h: ReturnType<typeof host>) => h.install(manifest(), 'market', { ...OFFICIAL, repo: 'someone/gugu-apps' })],
    ['the same id from the market with no record of its source', (h: ReturnType<typeof host>) => h.install(manifest(), 'market', null)],
    ['the same id from its release folder with no signed release recorded', (h: ReturnType<typeof host>) => h.install(manifest(), 'market', OFFICIAL, undefined, true)],
    ['the same id whose manifest on disk is no longer the signed one', (h: ReturnType<typeof host>) => {
      h.install();
      writeFileSync(path.join(h.service.get(ID).rootDir, 'manifest.json'), JSON.stringify({ ...manifest(), name: 'Edited' }));
    }],
  ])('refuses %s: no binding, no trust', async (_name, put) => {
    const h = host();
    put(h);
    expect(await sync(DM)).toMatchObject({ trusted: false, outcome: 'distrusted', changed: false });
    expect(h.bound()).toBeNull();
  });

  it('refuses a fork switched on, and touches no other App', async () => {
    const h = host();
    h.install();
    h.install(manifest('other-app'));
    const forked = new Proxy(h.service, { get: (target, key) => key === 'variants' ? () => ({ active: 'mine', variants: [] }) : Reflect.get(target, key, target) });
    expect(await distrust(forked)).toMatch(/fork "mine" is in use/);
    db.service = forked;
    expect(await sync(DM)).toMatchObject({ trusted: false, outcome: 'distrusted' });
    db.service = h.service;
    expect(h.bound()).toBeNull();
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(h.bound(OWNER, 'other-app')).toBeNull();
  });

  it('answers absent while the App is not in', async () => {
    host();
    expect(await sync(DM)).toMatchObject({ trusted: false, outcome: 'absent', changed: false });
  });

  it.each([
    ['a chat with another agent', () => { db.chats[DM] = { kind: 'dm', members: [OWNER, STRANGER] }; }],
    ['a group with the assistant in it', () => { db.chats[DM] = db.chats[GROUP]!; }],
    ['a chat it is not in', () => { db.chats[DM] = { kind: 'dm', members: [OTHER_OWNER, ASSISTANT] }; }],
    ['no assistant of its own', () => { db.assistants[OWNER] = null; }],
  ])('binds nothing the window names that is %s', async (_name, change) => {
    const { install, bound } = host();
    install();
    change();
    expect(await sync(DM)).toMatchObject({ trusted: true, outcome: 'refused', changed: false });
    expect(bound()).toBeNull();
  });

  it('does nothing it cannot verify now', async () => {
    const { install, bound } = host();
    install();
    db.down = true;
    expect(await sync(DM)).toMatchObject({ outcome: 'unverified', changed: false });
    expect(bound()).toBeNull();
  });
});

describe('it follows the assistant', () => {
  it('binds after the first setup made the chat, moves with it, goes at once on close, comes back on reopen', async () => {
    const { install, bound } = host();
    install();
    // No assistant yet: nothing to bind.
    db.assistants[OWNER] = null;
    expect(await sync(null)).toMatchObject({ outcome: 'kept', changed: false });
    // Setup made it and its chat.
    db.assistants[OWNER] = ASSISTANT;
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(DM);
    // A move that leaves it in a new chat (a new identity on its new home).
    db.assistants[OWNER] = NEW_ASSISTANT;
    db.chats[NEW_DM] = { kind: 'dm', members: [OWNER, NEW_ASSISTANT] };
    expect(await sync(NEW_DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(NEW_DM);
    // Closed: the window shows none, and main finds none — taken off, though the old chat is still there.
    db.assistants[OWNER] = null;
    expect(await sync(null)).toMatchObject({ outcome: 'unbound', changed: true });
    expect(bound()).toBeNull();
    // Opened again: a new one, a new chat.
    db.assistants[OWNER] = ASSISTANT;
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(DM);
  });

  it('keeps the binding while the window has no chat yet but the assistant is still there', async () => {
    const { install, bound } = host();
    install();
    await sync(DM);
    expect(await sync(null)).toMatchObject({ outcome: 'kept', changed: false });
    expect(bound()).toBe(DM);
    db.down = true;
    expect(await sync(null)).toMatchObject({ outcome: 'unverified' });
    expect(bound()).toBe(DM);
  });

  it('follows the account: each its own chat, an answer only for the signed-in one', async () => {
    const { install, bound } = host();
    install();
    await sync(DM);
    db.signedIn = OTHER_OWNER;
    db.assistants[OTHER_OWNER] = OTHER_ASSISTANT;
    await expect(sync(DM, OWNER)).rejects.toThrow(/Account changed/);
    expect(await sync(OTHER_DM, OTHER_OWNER)).toMatchObject({ ownerId: OTHER_OWNER, outcome: 'bound' });
    expect(bound(OTHER_OWNER)).toBe(OTHER_DM);
    expect(bound(OWNER)).toBe(DM);
    // The other account's assistant chat is not this account's.
    db.signedIn = OWNER;
    expect(await sync(OTHER_DM)).toMatchObject({ outcome: 'refused' });
    expect(bound(OWNER)).toBe(DM);
  });

  it('binds again after an update that changed the binding\'s declaration (the binding was reset)', async () => {
    const { install, bound } = host();
    install();
    await sync(DM);
    install(manifest(ID, '0.2.0', ['unread', 'surface', 'files']));
    expect(bound()).toBeNull();
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(DM);
  });
});

describe('the person\'s own choice stands', () => {
  it('never moves a conversation they picked, nor puts back one they removed', async () => {
    const { service, install, bound } = host();
    install();
    await sync(DM);
    service.setConversationUnreadBinding(OWNER, ID, 'main', GROUP, 'person');
    // Left alone at once: not even the chat is looked up.
    let reads = 0;
    db.afterRead = () => { reads += 1; };
    expect(await sync(DM)).toMatchObject({ trusted: true, outcome: 'chosen', changed: false });
    expect(reads).toBe(0);
    db.afterRead = undefined;
    expect(bound()).toBe(GROUP);
    db.assistants[OWNER] = null;
    expect(await sync(null)).toMatchObject({ outcome: 'chosen' });
    expect(bound()).toBe(GROUP);
    service.setConversationUnreadBinding(OWNER, ID, 'main', null, 'person');
    db.assistants[OWNER] = ASSISTANT;
    expect(await sync(DM)).toMatchObject({ outcome: 'chosen' });
    expect(bound()).toBeNull();
    // The service itself refuses a host write over it.
    expect(() => service.setConversationUnreadBinding(OWNER, ID, 'main', DM, 'host')).toThrow(/person chose/);
  });

  it('treats a binding it did not write as theirs (one from before the record was kept)', async () => {
    const { service, install, bound } = host();
    install();
    service.setConversationUnreadBinding(OWNER, ID, 'main', GROUP, 'person');
    // Forget who wrote it, as a profile from before the record would have it.
    const authors = path.join((service as unknown as { rootDir: string }).rootDir, '.conversation-binding-authors.json');
    writeFileSync(authors, '{}');
    expect(await sync(DM)).toMatchObject({ outcome: 'chosen' });
    expect(bound()).toBe(GROUP);
  });

  it('does not write when the person picks while it checks the chat', async () => {
    const { service, install, bound } = host();
    install();
    db.afterRead = () => { db.afterRead = undefined; service.setConversationUnreadBinding(OWNER, ID, 'main', GROUP, 'person'); };
    expect(await sync(DM)).toMatchObject({ outcome: 'chosen', changed: false });
    expect(bound()).toBe(GROUP);
  });

  it('leaves a withdrawn permission withdrawn, and a switched-off App off', async () => {
    const { service, install, bound } = host();
    install();
    await sync(DM);
    service.setPermissionGranted(ID, 'chat:unread', false);
    expect(await sync(DM)).toMatchObject({ trusted: true, outcome: 'withdrawn', changed: false });
    expect(service.revokedPermissions(ID)).toContain('chat:unread');
    expect(service.hasCapability(ID, 'chat:unread')).toBe(false);
    // Given back by the person: bound again by the host.
    service.setPermissionGranted(ID, 'chat:unread', true);
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(DM);
    service.setEnabled(ID, false);
    expect(await sync(DM)).toMatchObject({ outcome: 'off' });
  });

  it('forgets who chose with the App: installed again, the host binds it', async () => {
    const { service, install, bound } = host();
    install();
    service.setConversationUnreadBinding(OWNER, ID, 'main', GROUP, 'person');
    service.uninstall(ID);
    install();
    expect(await sync(DM)).toMatchObject({ outcome: 'bound' });
    expect(bound()).toBe(DM);
  });
});
