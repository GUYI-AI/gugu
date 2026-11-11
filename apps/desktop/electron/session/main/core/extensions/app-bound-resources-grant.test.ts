import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appPlatformProblems } from '@shared/extensions/app-platforms';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { ExtensionsService } from './extensions-service';
import { installPlan } from './install-plan';

/**
 * #1927 (API 42) The grant behind an App's reach into its bound conversation's agent resources: what a manifest may declare
 * (the actions, their capabilities and a closed list of domains), and what the installed App's grant answers — one domain
 * at a time, withdrawn on its own, failing closed, and telling whoever holds it past one call when it may have changed.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ELSEWHERE = '44000000-0000-4000-8000-000000000004';
const ID = 'assistant-app';
const READS = ['memory', 'files', 'personality', 'skills', 'voice-notes'];
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function manifest(options: { actions?: string[]; capabilities?: string[]; domains?: Record<string, unknown> | null; apiVersion?: number; platforms?: string[] } = {}) {
  const actions = options.actions ?? ['unread', 'resources', 'resources:write'];
  const capabilities = options.capabilities ?? ['chat:unread', ...actions.filter((action) => action !== 'unread').map((action) => `chat:${action}`)];
  const domains = options.domains === null ? undefined : options.domains ?? { resources: READS, 'resources:write': ['memory', 'personality'] };
  return { id: ID, name: 'Assistant', version: '1.0.0', apiVersion: options.apiVersion ?? EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: options.platforms ?? ['desktop'], entry: 'index.html',
    permissions: { capabilities, bindings: [{ name: 'main', kind: 'conversation', actions, ...(domains ? { domains } : {}) }] },
    contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } };
}
function fixture(value: object = manifest()) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-resources-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Assistant</p>');
  const service = new ExtensionsService(path.join(root, 'installed'));
  const install = (next: object = value, publisher = OWNER) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(next));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: publisher });
  };
  install(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
  return { service, install };
}
const refused = { code: 'denied' };

describe('declaring an agent\'s resources (manifest)', () => {
  it('needs API 42, each action with its capability and its domains; unread-only and files Apps parse as before', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(42);
    expect(() => parseExtensionManifest(manifest())).not.toThrow();
    expect(() => parseExtensionManifest(manifest({ actions: ['unread', 'resources'], domains: { resources: ['memory'] } }))).not.toThrow();
    expect(() => parseExtensionManifest(manifest({ actions: ['unread'], domains: null }))).not.toThrow();
    expect(() => parseExtensionManifest(manifest({ actions: ['unread', 'files', 'draft'], domains: null }))).not.toThrow();
    for (const apiVersion of [37, 40, 41]) expect(() => parseExtensionManifest(manifest({ apiVersion }))).toThrow(/apiVersion 42/);
    // An action without its capability, a capability without its action, either without the binding itself.
    expect(() => parseExtensionManifest(manifest({ capabilities: ['chat:unread', 'chat:resources'] }))).toThrow(/chat:resources:write/);
    expect(() => parseExtensionManifest(manifest({ actions: ['unread', 'resources'], capabilities: ['chat:unread'], domains: { resources: ['memory'] } }))).toThrow(/chat:resources/);
    expect(() => parseExtensionManifest(manifest({ actions: ['unread'], capabilities: ['chat:unread', 'chat:resources'], domains: null }))).toThrow(/chat:resources/);
    expect(() => parseExtensionManifest(manifest({ actions: ['resources'], capabilities: ['chat:resources'], domains: { resources: ['memory'] } }))).toThrow();
    // API 49: a phone takes the binding from 49 (phone-binding.ts), and refuses it before.
    expect(() => parseExtensionManifest({ ...manifest(), apiVersion: 48, platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest({ ...manifest(), apiVersion: 49, platforms: ['desktop', 'phone'] })).not.toThrow();
  });

  it('domains come with their action, from the closed list, each once; a writer writes only what it reads, never voice notes', () => {
    const bad = (domains: Record<string, unknown> | null, actions?: string[]) => () => parseExtensionManifest(manifest({ domains, ...(actions ? { actions } : {}) }));
    expect(bad(null)).toThrow(/domains/);
    expect(bad({ resources: ['memory'] })).toThrow(/resources:write/);
    expect(bad({ resources: ['memory'], 'resources:write': ['memory'] }, ['unread', 'resources'])).toThrow(/domains/);
    expect(bad({ resources: ['passwords'], 'resources:write': ['memory'] })).toThrow(/not a resource domain/);
    for (const domain of ['integrations', 'control', 'tasks', 'schedules', 'capabilities', 'device-notes']) {
      expect(bad({ resources: ['memory', domain], 'resources:write': ['memory'] })).toThrow(/never granted/);
      expect(bad({ resources: ['memory'], 'resources:write': [domain] })).toThrow(/never granted/);
    }
    expect(bad({ resources: READS, 'resources:write': ['voice-notes'] })).toThrow(/read only/);
    expect(bad({ resources: ['memory'], 'resources:write': ['files'] })).toThrow(/also reads/);
    expect(bad({ resources: ['memory', 'memory'], 'resources:write': ['memory'] })).toThrow(/each domain once/);
    expect(bad({ resources: [], 'resources:write': ['memory'] })).toThrow();
    expect(bad({ resources: ['memory'], 'resources:write': ['memory'], files: ['memory'] })).toThrow();
  });
});

describe('the installed App\'s resource grant', () => {
  it('one domain at a time: the action declared, its capability granted, the domain listed; nothing else opens', () => {
    const { service } = fixture();
    for (const domain of READS) expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', domain)?.chatId).toBe(CHAT);
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources:write', 'memory')?.chatId).toBe(CHAT);
    for (const domain of ['files', 'skills', 'voice-notes', 'integrations', 'control']) {
      expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources:write', domain)).toThrow(expect.objectContaining(refused));
    }
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'integrations')).toThrow(expect.objectContaining(refused));
    expect(() => service.conversationResourceBinding(OWNER, ID, 'other', 'resources', 'memory')).toThrow();
    // Another account chose nothing for this App.
    expect(service.conversationResourceBinding(OTHER, ID, 'main', 'resources', 'memory')).toBeNull();
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'resources', 'resources:write']);
    for (const word of ['chat:read', 'chat:files', 'files:read', 'files:write', 'agents:read', 'agents:control'] as const) expect(service.hasCapability(ID, word)).toBe(false);
    // A files-only App has no resource action at all.
    const files = fixture(manifest({ actions: ['unread', 'files'], domains: null }));
    expect(() => files.service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toThrow(expect.objectContaining(refused));
  });

  it('withdrawing either word stops it at once and keeps the selection; withdrawing chat:unread takes everything with it', () => {
    const { service } = fixture();
    service.setPermissionGranted(ID, 'chat:resources:write', false);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources:write', 'memory')).toThrow(expect.objectContaining(refused));
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')?.chatId).toBe(CHAT);
    service.setPermissionGranted(ID, 'chat:resources', false);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toThrow(expect.objectContaining(refused));
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread']);
    service.setPermissionGranted(ID, 'chat:resources', true);
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')?.chatId).toBe(CHAT);
    service.setPermissionGranted(ID, 'chat:unread', false);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toThrow();
    service.setPermissionGranted(ID, 'chat:unread', true);
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toBeNull();
  });

  it('fails closed disabled, uninstalled or for another publisher; the chosen conversation outlives another domain list', () => {
    const { service, install } = fixture();
    service.setEnabled(ID, false);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toThrow(expect.objectContaining(refused));
    service.setEnabled(ID, true);
    install(manifest({ domains: { 'resources:write': ['personality', 'memory'], resources: [...READS].reverse() } }));
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')?.chatId).toBe(CHAT);
    // More domains are asked as a permission when the update lands (below); the list itself answers at once, either way.
    install(manifest({ domains: { resources: READS, 'resources:write': ['memory', 'personality', 'skills'] } }));
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources:write', 'skills')?.chatId).toBe(CHAT);
    install(manifest({ domains: { resources: ['memory'], 'resources:write': ['memory'] } }));
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')?.chatId).toBe(CHAT);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'files')).toThrow(expect.objectContaining(refused));
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources:write', 'skills')).toThrow(expect.objectContaining(refused));
    install(manifest(), OTHER);
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toBeNull();
    service.uninstall(ID);
    expect(() => service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')).toThrow(expect.objectContaining(refused));
  });

  it('an update listing more domains, or adding the write action, asks for it as a new permission; fewer or the same asks nothing', () => {
    const reader = (resources: string[]) => manifest({ actions: ['unread', 'resources'], domains: { resources } });
    const { service, install } = fixture(reader(['memory']));
    const plan = (next: object) => {
      const { asks, newlyAsked } = installPlan(service, parseExtensionManifest(next), 'folder');
      return { asks, newlyAsked };
    };
    const quiet = { asks: false, newlyAsked: [] };
    expect(plan(reader(['memory']))).toEqual(quiet);
    expect(plan(reader(['memory', 'files']))).toEqual({ asks: true, newlyAsked: ['chat:resources'] });
    expect(plan(manifest({ domains: { resources: ['memory'], 'resources:write': ['memory'] } }))).toEqual({ asks: true, newlyAsked: ['chat:resources:write'] });
    // Measured against what landed: the wider one, once installed, is the baseline.
    install(manifest({ domains: { resources: READS, 'resources:write': ['memory', 'personality'] } }));
    expect(plan(manifest({ domains: { resources: [...READS].reverse(), 'resources:write': ['personality', 'memory'] } }))).toEqual(quiet);
    expect(plan(manifest({ domains: { resources: ['memory'], 'resources:write': ['memory'] } }))).toEqual(quiet);
    expect(plan(manifest({ domains: { resources: READS, 'resources:write': ['memory', 'personality', 'skills'] } })))
      .toEqual({ asks: true, newlyAsked: ['chat:resources:write'] });
    // A word the person withdrew stays withdrawn: listing more under it asks nothing (and reaches nothing).
    install(manifest({ domains: { resources: ['memory'], 'resources:write': ['memory'] } }));
    service.setPermissionGranted(ID, 'chat:resources:write', false);
    expect(plan(manifest({ domains: { resources: ['memory', 'skills'], 'resources:write': ['memory', 'skills'] } })))
      .toEqual({ asks: true, newlyAsked: ['chat:resources'] });
  });

  it('tells whoever holds the authority, after each change is written: a grant, enablement, choice, upgrade, uninstall', async () => {
    const { service, install } = fixture();
    await Promise.resolve(); // The fixture's own install and choice were told before anyone listened.
    const seen: string[] = [];
    const stop = service.onBindingAuthorityChanged((extensionId) => {
      let now: string;
      try { now = service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'memory')?.chatId ?? 'unbound'; } catch { now = 'refused'; }
      seen.push(`${extensionId}:${now}`);
    });
    const told = async (change: () => void) => { change(); await Promise.resolve(); return seen.splice(0); };
    expect(await told(() => service.setPermissionGranted(ID, 'chat:resources', false))).toEqual([`${ID}:refused`]);
    expect(await told(() => service.setPermissionGranted(ID, 'chat:resources', true))).toEqual([`${ID}:${CHAT}`]);
    expect(await told(() => service.setConversationUnreadBinding(OWNER, ID, 'main', ELSEWHERE))).toEqual([`${ID}:${ELSEWHERE}`]);
    expect(await told(() => service.setEnabled(ID, false))).toEqual([`${ID}:refused`]);
    expect(await told(() => service.setEnabled(ID, true))).toEqual([`${ID}:${ELSEWHERE}`]);
    expect(await told(() => install(manifest(), OTHER))).toEqual([`${ID}:unbound`]);
    expect(await told(() => service.uninstall(ID))).toEqual([`${ID}:refused`]);
    stop();
    install();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  it('at the shared door: reads need chat:resources, changes chat:resources:write, a page only; nothing else opens', () => {
    const { service } = fixture();
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = { kind: 'page' as const, gesture: false, widget: false, has };
    const change = { name: 'main', domain: 'memory', key: 'a.md', operationId: '55000000-0000-4000-8000-000000000005', expectedRevision: '0', content: 'x' };
    for (const [verb, args] of [['bindingsResources', { name: 'main', domain: 'memory' }], ['bindingsResource', { name: 'main', domain: 'memory', key: 'a.md' }],
      ['bindingsWatch', { watchId: '1', name: 'main', on: true }], ['bindingsSave', change], ['bindingsRemove', change]] as const) {
      expect(callRefusal(verb, args, page)).toBeNull();
      for (const kind of ['background', 'program'] as const) expect(callRefusal(verb, args, { kind, has })?.code).toBe('invalid');
    }
    for (const [verb, args] of [['filesList', { place: { chat: CHAT } }], ['messagesHistory', { chat: CHAT }], ['chatsList', {}], ['bindingsList', { name: 'main' }],
      ['listAgents', {}], ['dispatch', { text: 'x', to: { agent: `user:${OTHER}` } }]] as const) expect(callRefusal(verb, args, page)?.code).toBe('denied');
    service.setPermissionGranted(ID, 'chat:resources:write', false);
    expect(callRefusal('bindingsSave', change, page)?.code).toBe('denied');
    expect(callRefusal('bindingsRemove', change, page)?.code).toBe('denied');
    expect(callRefusal('bindingsResource', { name: 'main', domain: 'memory', key: 'a.md' }, page)).toBeNull();
    service.setPermissionGranted(ID, 'chat:resources', false);
    expect(callRefusal('bindingsResources', { name: 'main', domain: 'memory' }, page)?.code).toBe('denied');
    expect(callRefusal('bindingsWatch', { watchId: '1', name: 'main', on: true }, page)?.code).toBe('denied');
  });
});

describe('#50 managing voice notes (voice-notes:manage)', () => {
  const manager = (patch: { apiVersion?: number; reads?: string[]; capabilities?: string[] } = {}) => manifest({
    actions: ['unread', 'resources', 'voice-notes:manage'], apiVersion: patch.apiVersion,
    ...(patch.capabilities ? { capabilities: patch.capabilities } : {}),
    domains: { resources: patch.reads ?? ['memory', 'voice-notes'] } });

  it('needs API 50, its capability, and voice-notes read by the same binding; a phone answers it unsupported', () => {
    expect(() => parseExtensionManifest(manager())).not.toThrow();
    expect(() => parseExtensionManifest(manager({ apiVersion: 49 }))).toThrow(/apiVersion 50/);
    expect(() => parseExtensionManifest(manager({ reads: ['memory'] }))).toThrow(/voice-notes/);
    expect(() => parseExtensionManifest(manager({ capabilities: ['chat:unread', 'chat:resources'] }))).toThrow(/chat:voice-notes:manage/);
    // On a phone (49): declared there without refusal; the phone answers each managing verb `unsupported` (phone-binding.ts).
    expect(() => parseExtensionManifest({ ...manager(), platforms: ['desktop', 'phone'] })).not.toThrow();
    expect(appPlatformProblems({ ...manager(), platforms: ['desktop', 'phone'] })).toEqual([]);
  });

  it('is its own grant: withdrawn on its own, not opened by reading voice notes, refused at the door without it', () => {
    const { service } = fixture(manager());
    expect(service.conversationBinding(OWNER, ID, 'main', 'voice-notes:manage')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'resources', 'voice-notes:manage']);
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const key = { name: 'main', key: 'n1' };
    expect(callRefusal('bindingsRemoveVoiceNote', key, { kind: 'page', gesture: true, widget: false, has })).toBeNull();
    expect(callRefusal('bindingsRemoveVoiceNote', key, { kind: 'page', gesture: false, widget: false, has })).not.toBeNull();
    service.setPermissionGranted(ID, 'chat:voice-notes:manage', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'voice-notes:manage')).toThrow(expect.objectContaining(refused));
    expect(service.conversationResourceBinding(OWNER, ID, 'main', 'resources', 'voice-notes')?.chatId).toBe(CHAT);
    for (const verb of ['bindingsTranscribeVoiceNote', 'bindingsRemoveVoiceNote', 'bindingsExportVoiceNote']) {
      expect(callRefusal(verb, key, { kind: 'page', gesture: true, widget: false, has })?.code).toBe('denied');
    }
    // A reader of voice notes alone manages none.
    const reader = fixture(manifest({ actions: ['unread', 'resources'], domains: { resources: ['voice-notes'] } }));
    expect(() => reader.service.conversationBinding(OWNER, ID, 'main', 'voice-notes:manage')).toThrow(expect.objectContaining(refused));
  });
});

vi.setConfig({ testTimeout: 20_000 });
