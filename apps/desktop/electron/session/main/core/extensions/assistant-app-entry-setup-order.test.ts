import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUGU_APPS_REPO, type MarketCodeSource } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust } from './test-support/signed-release';

/**
 * verify-pass1 D4, the host's half: the person installs the assistant App first and sets the assistant up after. The assistant's
 * private chat exists, with the assistant in it, while its setup is still under way; the App's own calls over a binding
 * (resources) are served only once the assistant is ready for that chat. Before, the host bound the App at the first moment, the
 * App's `onResourcesChanged` was refused ("not your private conversation") and reported as an error that sat on the page, and the
 * App's side-panel entries were missing until a reload. Now: nothing is bound until the chat passes the same check the App's calls
 * stand on, a call over a binding that is not valid yet is answered `unbound` (never an error to report), and the moment the
 * binding is valid the App's page hears `onSurface` `bound` through the one way it is told.
 *
 * Real extensions service, real manifest and trust check, the real surface push to a page; the account and the database
 * (provision marker, chats, members) are faked, and the page is a fake web contents that records what it is sent.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const DM = '33000000-0000-4000-8000-000000000003';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const DEVICE = '55000000-0000-4000-8000-000000000005';
const STRANGER = '66000000-0000-4000-8000-000000000006';
const GROUP = '77000000-0000-4000-8000-000000000007';
const ID = 'gugu-assistant';
const PAGE = 71;

const db = vi.hoisted(() => ({
  assistant: null as string | null,
  phase: 'ready',
  chats: {} as Record<string, { kind: string; members: string[] }>,
  service: null as unknown,
  sent: new Map<number, unknown[]>(),
}));
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => ({
    id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: { id }, once: () => undefined, on: () => undefined,
    send: (_channel: string, event: unknown) => db.sent.set(id, [...(db.sent.get(id) ?? []), event]),
  }) },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'gugu-assistant', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => OWNER }));
vi.mock('./extensions-root', () => ({ extensionsService: () => db.service }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: ({ schema }: { schema: string }) => ({ from: (table: string) => {
  const filters: Record<string, string> = {};
  const answer = () => {
    if (schema === 'identity') {
      const dm = Object.entries(db.chats).find(([, one]) => one.kind === 'dm' && !!db.assistant && one.members.includes(db.assistant))?.[0] ?? null;
      return { data: db.assistant ? [{ agent_user_id: db.assistant, device_id: DEVICE, member_key: 'assistant', phase: db.phase, created_at: '2026-11-01T00:00:00Z', dm_chat_id: dm, agent: { owner_user_id: OWNER, removed_at: null } }] : [], error: null };
    }
    const chat = db.chats[filters.id ?? filters.chat_id ?? ''];
    if (table === 'chats') return { data: chat ? { kind: chat.kind } : null, error: null };
    return { data: (chat?.members ?? []).map((user_id) => ({ user_id, chat_id: filters.chat_id })), error: null };
  };
  const query: Record<string, unknown> = {
    select: () => query,
    eq: (column: string, value: string) => { filters[column] = value; return query; },
    in: () => query,
    limit: () => query,
    abortSignal: () => query,
    maybeSingle: async () => { const found = answer(); return Array.isArray(found.data) ? { data: found.data[0] ?? null, error: null } : found; },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(answer).then(resolve, reject),
  };
  return query;
} }) }));

const { syncAssistantAppEntry } = await import('./assistant-app-entry');
const { assistantRulesTrust } = await import('../../../../assistant-rules-trust');
const { appResourceList, appResourceWatch } = await import('./app-bound-resources');
const { reportConversationSurface } = await import('./app-unread-bindings');
const { bindExtensionSurface, pushBindingSurfaces, unbindExtensionSurface } = await import('./extension-bridge');

const KEY = testKey('gugu-assistant-entry-setup-order');
const TRUST = assistantRulesTrust(testTrust(KEY, [ID]));
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

const official: MarketCodeSource = { repo: GUGU_APPS_REPO, path: 'releases/gugu-assistant/0.1.0', commit: 'a'.repeat(40) };
const manifest = {
  id: ID, name: 'Assistant', version: '0.1.0', apiVersion: 45, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
  permissions: { capabilities: ['chat:unread', 'chat:surface', 'chat:resources'], bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'surface', 'resources'], domains: { resources: ['memory'] } }] },
  contributes: { tabs: [{ name: 'today', title: 'Today' }], conversationSurface: { binding: 'main', placement: 'side-panel' } },
};
function installApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'assistant-app-order-')); roots.push(root);
  const service = new ExtensionsService(path.join(root, 'installed'));
  db.service = service;
  const dir = path.join(root, 'source'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<p>Assistant</p>');
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(RELEASE_LEGAL_FILES)) writeFileSync(path.join(dir, name), text);
  const release = signTestRelease({ appDir: dir, appId: ID, version: '0.1.0', zip: new Uint8Array(), key: KEY }).proof;
  service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, 'market', undefined, undefined, { ...official, release });
  return service;
}
const sync = (chatId: string | null) => syncAssistantAppEntry({ ownerId: OWNER, chatId }, { trust: TRUST, ensureApp: vi.fn() });
const surfaceEvents = () => (db.sent.get(PAGE) ?? []).filter((event) => (event as { type?: string }).type === 'bindingSurface') as { surface: { state: string } }[];
/** What the window does once the binding is there: it draws the conversation beside the App's page and says so. */
const windowDrawsConversation = () => reportConversationSurface({ extensionId: ID, tabKind: `${ID}.today`, tabId: 'dock', shown: { chatId: DM, collapsed: false } });

beforeEach(async () => {
  db.assistant = null;
  db.phase = 'ready';
  db.chats = { [DM]: { kind: 'dm', members: [OWNER, ASSISTANT] }, [GROUP]: { kind: 'group', members: [OWNER, ASSISTANT, STRANGER] } };
  db.sent.clear();
  const service = installApp();
  void service;
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: ID, tabId: 'dock', tabKind: `${ID}.today` });
  db.sent.clear();
  return () => unbindExtensionSurface(PAGE);
});

describe('the App is installed first, the assistant is set up after', () => {
  it('binds nothing while the setup is under way, and the moment the chat is ready binds it and the page hears onSurface bound', async () => {
    const service = db.service as ExtensionsService;
    const bound = () => service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId ?? null;
    // Installed, no assistant yet: nothing to bind.
    expect(await sync(null)).toMatchObject({ trusted: true, outcome: 'kept', changed: false });

    // The person sets it up: the chat exists with the assistant in it, the setup is not finished.
    db.assistant = ASSISTANT;
    db.phase = 'preparing';
    expect(await sync(DM)).toMatchObject({ outcome: 'pending', changed: false });
    expect(bound()).toBeNull();
    await pushBindingSurfaces(ID);
    expect(surfaceEvents().every((event) => event.surface.state === 'unbound'), 'the page is never told bound while nothing is').toBe(true);

    // Ready: bound at once, the page told, and the window drawing the conversation beside it makes it `bound` for the page.
    db.phase = 'ready';
    db.sent.clear();
    expect(await sync(DM)).toMatchObject({ outcome: 'bound', changed: true });
    expect(bound()).toBe(DM);
    expect(surfaceEvents().length, 'the page is told the binding changed').toBeGreaterThan(0);
    expect(windowDrawsConversation()).toBe(true);
    await pushBindingSurfaces(ID);
    expect(surfaceEvents().at(-1)?.surface).toMatchObject({ name: 'main', state: 'bound', layout: 'side-panel' });
  });

  it('a call over a binding that is not valid yet is answered unbound — no error for the App to report — and a real refusal still is one', async () => {
    const service = db.service as ExtensionsService;
    // A binding there before the setup was ready (an earlier build wrote it; the person's own choice would be the same).
    db.assistant = ASSISTANT;
    db.phase = 'preparing';
    service.setConversationUnreadBinding(OWNER, ID, 'main', DM, 'host');
    const heard: unknown[] = [];
    await expect(appResourceWatch(ID, PAGE, { watchId: '1', name: 'main', on: true }, (_id, event) => heard.push(event))).resolves.toEqual({ name: 'main', state: 'unbound' });
    await expect(appResourceList(ID, { name: 'main', domain: 'memory' })).resolves.toMatchObject({ name: 'main', state: 'unbound' });
    expect(heard).toEqual([]);
    // Ready: the same calls are served by the store (the store itself is not faked here: the binding is valid, the check passes).
    db.phase = 'ready';
    await expect(appResourceWatch(ID, PAGE, { watchId: '2', name: 'main', on: true }, (_id, event) => heard.push(event))).resolves.toEqual({ name: 'main', state: 'watching' });
    // A conversation that is not the assistant's at all is a refusal, whatever the phase.
    service.setConversationUnreadBinding(OWNER, ID, 'main', GROUP, 'host');
    await expect(appResourceWatch(ID, PAGE, { watchId: '3', name: 'main', on: true }, () => undefined)).rejects.toMatchObject({ code: 'denied' });
  });
});
