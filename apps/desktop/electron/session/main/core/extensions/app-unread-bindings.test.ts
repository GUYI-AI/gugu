import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { ExtensionsService } from './extensions-service';

const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ID = 'unread-reader';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function manifest(name = 'main', granted = true) {
  return { id: ID, name: 'Unread reader', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
    defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: granted ? { capabilities: ['chat:unread'], bindings: [{ name, kind: 'conversation', actions: ['unread'] }] } : {},
    contributes: { tabs: [{ name: 'main', title: 'Unread reader' }] } };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'app-unread-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Unread reader</p>');
  const installed = path.join(root, 'installed');
  const service = new ExtensionsService(installed);
  const install = (value = manifest(), publisher = OWNER) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(value));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: publisher });
  };
  install(); return { service, installed, install };
}

describe('one-conversation unread permission boundary', () => {
  it('rejects content actions, multiple targets, unknown target authority and older API declarations', () => {
    const good = manifest(); expect(() => parseExtensionManifest(good)).not.toThrow();
    for (const bindings of [
      [{ name: 'main', kind: 'conversation', actions: ['unread', 'read'] }],
      [{ name: 'main', kind: 'conversation', actions: ['unread'], chatId: CHAT }],
      [{ name: 'main', kind: 'conversation', actions: ['unread'] }, { name: 'other', kind: 'conversation', actions: ['unread'] }],
    ]) expect(() => parseExtensionManifest({ ...good, permissions: { capabilities: ['chat:unread'], bindings } })).toThrow();
    expect(() => parseExtensionManifest({ ...good, permissions: { capabilities: ['chat:unread'] } })).toThrow();
    for (const apiVersion of [35, 36]) expect(() => parseExtensionManifest({ ...good, apiVersion })).toThrow();
    expect(() => parseExtensionManifest({ ...good, apiVersion: 36, permissions: {} })).not.toThrow();
  });

  it('persists a selection across host restart, partitioned by actual account and installed publisher', () => {
    const { service, installed } = fixture();
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const binding = service.conversationUnreadBinding(OWNER, ID, 'main');
    expect(binding?.chatId).toBe(CHAT);
    expect(new ExtensionsService(installed).conversationUnreadBinding(OWNER, ID, 'main')).toEqual(binding);
    expect(service.conversationUnreadBinding(OTHER, ID, 'main')).toBeNull();
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'other')).toThrow();
    expect(service.hasCapability(ID, 'chat:read')).toBe(false);
    expect(service.hasCapability(ID, 'agents:control')).toBe(false);
  });

  it('refuses actual content, other-chat content, chat enumeration and Agent control at the shared bridge door', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const caller = { kind: 'page' as const, gesture: true, widget: false, has: (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word) };
    expect(callRefusal('bindingsGet', { name: 'main' }, caller)).toBeNull();
    for (const [verb, args] of [
      ['messagesHistory', { chat: CHAT }], ['messagesHistory', { chat: OTHER }],
      ['messagesSearch', { chat: CHAT, query: 'secret' }], ['chatsList', {}],
      ['chatsMembers', { chat: OTHER }], ['dispatch', { text: 'run', to: { agent: `user:${OTHER}` } }],
    ] as const) expect(callRefusal(verb, args, caller)?.code).toBe('denied');
  });

  it('invalidates the selection on revocation and does not revive it when the capability is restored', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setPermissionGranted(ID, 'chat:unread', false);
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'main')).toThrow();
    service.setPermissionGranted(ID, 'chat:unread', true);
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
  });

  it('does not transfer a target to a different publisher, renamed declaration or reinstall', () => {
    const { service, install } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(manifest(), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(manifest('changed'), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'changed')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'changed', CHAT);
    service.uninstall(ID); install(manifest('changed'), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'changed')).toBeNull();
  });

  it('stops authority while disabled and removes the old target when its declaration is removed', () => {
    const { service, install } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setEnabled(ID, false);
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'main')).toThrow();
    service.setEnabled(ID, true);
    install(manifest('main', false)); install();
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
  });

  it('does not reuse a permission selection authority across accounts', () => {
    const { service } = fixture();
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(service.conversationUnreadAuthority(OTHER, ID, 'main'));
  });

  it.each(['rebind', 'remove', 'revoke-restore', 'disable-enable', 'compatible-upgrade', 'publisher-change', 'reinstall'])(
    'invalidates a pending permission selection on %s', change => {
      const { service, install } = fixture();
      service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
      const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
      expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).toBe(authority);
      switch (change) {
        case 'rebind': service.setConversationUnreadBinding(OWNER, ID, 'main', OTHER); break;
        case 'remove': service.setConversationUnreadBinding(OWNER, ID, 'main', null); break;
        case 'revoke-restore': service.setPermissionGranted(ID, 'chat:unread', false); service.setPermissionGranted(ID, 'chat:unread', true); break;
        case 'disable-enable': service.setEnabled(ID, false); service.setEnabled(ID, true); break;
        case 'compatible-upgrade': install(); expect(service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId).toBe(CHAT); break;
        case 'publisher-change': install(manifest(), OTHER); break;
        case 'reinstall': service.uninstall(ID); install(); break;
      }
      expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    },
  );
});

/** #1927 (API 40): the same binding's `files` and `draft` actions, each with its own capability. */
function boundManifest(actions: string[] = ['unread', 'files', 'draft'], capabilities?: string[], apiVersion = EXTENSION_API_VERSION) {
  return { ...manifest(), apiVersion, permissions: { capabilities: capabilities ?? ['chat:unread', ...actions.filter(a => a !== 'unread').map(a => `chat:${a}`)],
    bindings: [{ name: 'main', kind: 'conversation', actions }] } };
}
function boundFixture(value = boundManifest()) {
  const made = fixture(); made.install(value); return made;
}

describe('the bound conversation\'s files and draft (#1927, API 40)', () => {
  it('needs API 40 and each action declared with its own capability; an unread-only App parses as before', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(40);
    expect(() => parseExtensionManifest(boundManifest())).not.toThrow();
    expect(() => parseExtensionManifest(boundManifest(['unread', 'files']))).not.toThrow();
    expect(() => parseExtensionManifest(boundManifest(['unread', 'draft']))).not.toThrow();
    expect(() => parseExtensionManifest({ ...manifest(), apiVersion: 37 })).not.toThrow();
    for (const apiVersion of [37, 38, 39]) {
      expect(() => parseExtensionManifest(boundManifest(['unread', 'files'], undefined, apiVersion))).toThrow(/apiVersion 40/);
      expect(() => parseExtensionManifest(boundManifest(['unread', 'draft'], undefined, apiVersion))).toThrow(/apiVersion 40/);
    }
    // An action without its capability, a capability without its action, an action without the binding itself.
    expect(() => parseExtensionManifest(boundManifest(['unread', 'files'], ['chat:unread']))).toThrow(/chat:files/);
    expect(() => parseExtensionManifest(boundManifest(['unread'], ['chat:unread', 'chat:files']))).toThrow(/chat:files/);
    expect(() => parseExtensionManifest(boundManifest(['unread'], ['chat:unread', 'chat:draft']))).toThrow(/chat:draft/);
    expect(() => parseExtensionManifest({ ...manifest(), permissions: { capabilities: ['chat:files'] } })).toThrow();
    for (const actions of [['files'], ['unread', 'files', 'files'], ['unread', 'write'], ['unread', 'files', 'draft', 'read']]) {
      expect(() => parseExtensionManifest(boundManifest(actions, ['chat:unread', 'chat:files']))).toThrow();
    }
    // API 49: a phone takes the binding from 49 (phone-binding.ts), and refuses it before.
    expect(() => parseExtensionManifest({ ...boundManifest(), apiVersion: 48, platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest({ ...boundManifest(), apiVersion: 49, platforms: ['desktop', 'phone'] })).not.toThrow();
  });

  it('reaches the one selected conversation only with the action declared and its capability granted', () => {
    const { service } = boundFixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'files')?.chatId).toBe(CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'draft')?.chatId).toBe(CHAT);
    expect(service.conversationBinding(OTHER, ID, 'main', 'files')).toBeNull();
    expect(() => service.conversationBinding(OWNER, ID, 'other', 'files')).toThrow();
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'files', 'draft']);
    // Neither grant is chat:read, files:read, a relay or Agent control.
    for (const word of ['chat:read', 'files:read', 'files:write', 'chat:relay', 'agents:control'] as const) expect(service.hasCapability(ID, word)).toBe(false);
  });

  it('refuses a binding without the action: an unread-only App keeps exactly the unread answer', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread']);
    for (const action of ['files', 'draft'] as const) expect(() => service.conversationBinding(OWNER, ID, 'main', action)).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('withdrawing chat:files stops files at once and keeps unread and draft; restoring it reads the same selection', () => {
    const { service } = boundFixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
    service.setPermissionGranted(ID, 'chat:files', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'files')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(service.conversationBinding(OWNER, ID, 'main', 'draft')?.chatId).toBe(CHAT);
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'draft']);
    // A chooser drawn before the grant changed must ask again.
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    service.setPermissionGranted(ID, 'chat:files', true);
    expect(service.conversationBinding(OWNER, ID, 'main', 'files')?.chatId).toBe(CHAT);
  });

  it('withdrawing chat:unread takes every action with the selection; restored, nothing comes back without a new choice', () => {
    const { service } = boundFixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setPermissionGranted(ID, 'chat:unread', false);
    for (const action of ['files', 'draft'] as const) expect(() => service.conversationBinding(OWNER, ID, 'main', action)).toThrow();
    service.setPermissionGranted(ID, 'chat:unread', true);
    for (const action of ['files', 'draft'] as const) expect(service.conversationBinding(OWNER, ID, 'main', action)).toBeNull();
  });

  it('fails closed while disabled, after uninstall, for another publisher and when an upgrade adds an action', () => {
    const { service, install } = boundFixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setEnabled(ID, false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'files')).toThrow(expect.objectContaining({ code: 'denied' }));
    service.setEnabled(ID, true);
    service.uninstall(ID);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'files')).toThrow(expect.objectContaining({ code: 'denied' }));
    install(boundManifest());
    expect(service.conversationBinding(OWNER, ID, 'main', 'files')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(boundManifest(), OTHER);
    expect(service.conversationBinding(OWNER, ID, 'main', 'files')).toBeNull();
    // The same actions in another order are the same declaration: the selection stays.
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(boundManifest(['unread', 'draft', 'files']), OTHER);
    expect(service.conversationBinding(OWNER, ID, 'main', 'files')?.chatId).toBe(CHAT);
    // An unread-only selection does not carry over to a version that adds files: the person chooses again.
    const unreadOnly = fixture(); unreadOnly.service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    unreadOnly.install(boundManifest());
    expect(unreadOnly.service.conversationBinding(OWNER, ID, 'main', 'files')).toBeNull();
  });

  it('at the shared door: files need chat:files, a bound draft needs chat:draft and a gesture; nothing else opens', () => {
    const { service } = boundFixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = (gesture = true) => ({ kind: 'page' as const, gesture, widget: false, has });
    const draft = { text: 'Ask about today', draft: true, to: { binding: 'main' } };
    expect(callRefusal('bindingsList', { name: 'main' }, page())).toBeNull();
    expect(callRefusal('bindingsRead', { name: 'main', path: 'today.json' }, page())).toBeNull();
    expect(callRefusal('dispatch', draft, page())).toBeNull();
    expect(callRefusal('dispatch', draft, page(false))?.code).toBe('denied');
    for (const kind of ['background', 'program'] as const) {
      // A page's own verb: not on a background page's or a program's `gugu` at all.
      expect(callRefusal('bindingsRead', { name: 'main', path: 'today.json' }, { kind, has })?.code).toBe('invalid');
      expect(callRefusal('dispatch', draft, { kind, has })?.code).toBe('denied');
    }
    for (const [verb, args] of [
      ['filesList', { place: { chat: CHAT } }], ['filesSearch', { query: 'today' }], ['messagesHistory', { chat: CHAT }],
      ['chatsList', {}], ['dispatch', { text: 'x', to: { chat: CHAT, member: `user:${OTHER}` } }],
    ] as const) expect(callRefusal(verb, args, page())?.code).toBe('denied');
    service.setPermissionGranted(ID, 'chat:files', false);
    service.setPermissionGranted(ID, 'chat:draft', false);
    expect(callRefusal('bindingsList', { name: 'main' }, page())?.code).toBe('denied');
    expect(callRefusal('bindingsRead', { name: 'main', path: 'today.json' }, page())?.code).toBe('denied');
    expect(callRefusal('dispatch', draft, page())?.code).toBe('denied');
    // A plain chat draft needs no capability, as before.
    expect(callRefusal('dispatch', { text: 'x', draft: true, to: { chat: CHAT } }, page())).toBeNull();
  });
});

/** #1925 (API 41): the same binding's `surface` action — the App's main page drawn beside that conversation. */
// `surface: null`: no `contributes.conversationSurface` at all.
function surfaceManifest({ actions = ['unread', 'surface'], capabilities, apiVersion = EXTENSION_API_VERSION, surface = { binding: 'main', placement: 'side-panel' } as unknown }: {
  actions?: string[]; capabilities?: string[]; apiVersion?: number; surface?: unknown;
} = {}) {
  const base = manifest();
  return { ...base, apiVersion,
    permissions: { capabilities: capabilities ?? ['chat:unread', ...actions.filter(a => a !== 'unread').map(a => `chat:${a}`)], bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { ...base.contributes, ...(surface === null ? {} : { conversationSurface: surface }) } };
}

describe('the bound conversation beside the App\'s page (#1925, API 41)', () => {
  it('needs API 41, the surface action with chat:surface, and conversationSurface naming that binding', () => {
    // The host speaks 41 or later (46 adds `work`, below).
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(41);
    expect(() => parseExtensionManifest(surfaceManifest())).not.toThrow();
    expect(() => parseExtensionManifest(surfaceManifest({ actions: ['unread', 'files', 'draft', 'surface'] }))).not.toThrow();
    // An App of before parses as it did: no surface, no conversationSurface.
    expect(() => parseExtensionManifest(manifest())).not.toThrow();
    expect(() => parseExtensionManifest(boundManifest())).not.toThrow();
    for (const apiVersion of [37, 39, 40]) expect(() => parseExtensionManifest(surfaceManifest({ apiVersion }))).toThrow(/apiVersion 41/);
    // The action without its capability, the capability without its action.
    expect(() => parseExtensionManifest(surfaceManifest({ capabilities: ['chat:unread'] }))).toThrow(/chat:surface/);
    expect(() => parseExtensionManifest(surfaceManifest({ actions: ['unread'], capabilities: ['chat:unread', 'chat:surface'] }))).toThrow(/chat:surface/);
    // The placement without the action, the action without the placement, a placement naming another binding or layout.
    expect(() => parseExtensionManifest(surfaceManifest({ actions: ['unread'] }))).toThrow(/conversationSurface/);
    expect(() => parseExtensionManifest(surfaceManifest({ surface: null }))).toThrow(/conversationSurface/);
    expect(() => parseExtensionManifest(surfaceManifest({ surface: { binding: 'other', placement: 'side-panel' } }))).toThrow(/conversationSurface/);
    for (const surface of [{ binding: 'main', placement: 'left' }, { binding: 'main' }, { binding: 'main', placement: 'side-panel', chatId: CHAT }]) {
      expect(() => parseExtensionManifest(surfaceManifest({ surface }))).toThrow();
    }
    // Without any binding at all: a surface has no conversation to be beside.
    const unbound = { ...manifest(), permissions: { capabilities: ['chat:surface'] }, contributes: { ...manifest().contributes, conversationSurface: { binding: 'main', placement: 'side-panel' } } };
    expect(() => parseExtensionManifest(unbound)).toThrow();
    // API 49: a phone takes the binding from 49 (phone-binding.ts), and refuses it before.
    expect(() => parseExtensionManifest({ ...surfaceManifest(), apiVersion: 48, platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest({ ...surfaceManifest(), apiVersion: 49, platforms: ['desktop', 'phone'] })).not.toThrow();
  });

  it('46: the host\'s row above the conversation (`header: "assistant"`), from 46 on, a row the host knows, desktop only', () => {
    const header = { binding: 'main', placement: 'side-panel', header: 'assistant' };
    expect(() => parseExtensionManifest(surfaceManifest({ surface: header, apiVersion: 46 }))).not.toThrow();
    for (const apiVersion of [41, 44, 45]) expect(() => parseExtensionManifest(surfaceManifest({ surface: header, apiVersion }))).toThrow(/apiVersion 46/);
    for (const other of ['profile', 'Assistant', '', true, { kind: 'assistant' }]) {
      expect(() => parseExtensionManifest(surfaceManifest({ surface: { ...header, header: other }, apiVersion: 46 }))).toThrow();
    }
    // On a phone the binding needs 49 (phone-binding.ts); there the layer's own header is the row, whatever is declared.
    expect(() => parseExtensionManifest({ ...surfaceManifest({ surface: header, apiVersion: 46 }), platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest({ ...surfaceManifest({ surface: header, apiVersion: 49 }), platforms: ['desktop', 'phone'] })).not.toThrow();
  });

  it('reaches the selected conversation only with the action declared and chat:surface granted; withdrawn, only surface stops', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'surface')).toThrow(expect.objectContaining({ code: 'denied' }));
    const surfaced = fixture(); surfaced.install(surfaceManifest({ actions: ['unread', 'draft', 'surface'] }));
    surfaced.service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(surfaced.service.conversationBinding(OWNER, ID, 'main', 'surface')?.chatId).toBe(CHAT);
    expect(surfaced.service.conversationBinding(OTHER, ID, 'main', 'surface')).toBeNull();
    expect(surfaced.service.conversationBindingActions(ID)).toEqual(['unread', 'draft', 'surface']);
    for (const word of ['chat:read', 'chat:files', 'files:read', 'chat:relay', 'agents:control'] as const) expect(surfaced.service.hasCapability(ID, word)).toBe(false);
    const authority = surfaced.service.conversationUnreadAuthority(OWNER, ID, 'main');
    surfaced.service.setPermissionGranted(ID, 'chat:surface', false);
    expect(() => surfaced.service.conversationBinding(OWNER, ID, 'main', 'surface')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(surfaced.service.conversationBinding(OWNER, ID, 'main', 'draft')?.chatId).toBe(CHAT);
    expect(surfaced.service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    surfaced.service.setEnabled(ID, false);
    surfaced.service.setPermissionGranted(ID, 'chat:surface', true);
    expect(() => surfaced.service.conversationBinding(OWNER, ID, 'main', 'surface')).toThrow(expect.objectContaining({ code: 'denied' }));
    surfaced.service.setEnabled(ID, true);
    surfaced.service.uninstall(ID);
    expect(() => surfaced.service.conversationBinding(OWNER, ID, 'main', 'surface')).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('its authority stamp: kept through another App\'s install, update, grants and removal; new on any change of this App\'s', () => {
    const { service, install } = fixture(); install(surfaceManifest({ actions: ['unread', 'files', 'draft', 'surface'] }));
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const stamp = () => service.conversationSurfaceAuthority(OWNER, ID, 'main');
    // Another account's is another stamp, and replaces this one: switched back, it is new again.
    const first = stamp();
    expect(service.conversationSurfaceAuthority(OTHER, ID, 'main')).not.toBe(first);
    let before = stamp();
    expect(before).not.toBe(first);
    expect(stamp()).toBe(before);
    // Another App: installed, updated, its grant withdrawn and given back, switched off and on, uninstalled.
    const other = { ...surfaceManifest(), id: 'other-app' };
    install(other); install({ ...other, version: '2.0.0' });
    service.setPermissionGranted('other-app', 'chat:surface', false); service.setPermissionGranted('other-app', 'chat:surface', true);
    service.setPermissionGranted('other-app', 'chat:unread', false);
    service.setEnabled('other-app', false); service.setEnabled('other-app', true);
    service.uninstall('other-app');
    // This App's grants that are not the surface's.
    service.setPermissionGranted(ID, 'chat:files', false); service.setPermissionGranted(ID, 'chat:draft', false);
    expect(stamp()).toBe(before);
    // This App's: its surface grant withdrawn and given back, its switch, its choice (even the same chat), a reinstall.
    for (const change of [
      () => { service.setPermissionGranted(ID, 'chat:surface', false); service.setPermissionGranted(ID, 'chat:surface', true); },
      () => { service.setEnabled(ID, false); service.setEnabled(ID, true); },
      () => service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT),
      () => install(surfaceManifest({ actions: ['unread', 'files', 'draft', 'surface'] })),
    ]) {
      change();
      expect(stamp()).not.toBe(before);
      before = stamp();
    }
    // Withdrawn, cleared or gone: there is no authority to stamp.
    service.setPermissionGranted(ID, 'chat:surface', false);
    expect(() => stamp()).toThrow(expect.objectContaining({ code: 'denied' }));
    service.setPermissionGranted(ID, 'chat:surface', true);
    service.setPermissionGranted(ID, 'chat:unread', false);
    expect(() => stamp()).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('at the shared door: surface and setPanel need chat:surface, are a page\'s, and open nothing else', () => {
    const { service, install } = fixture(); install(surfaceManifest());
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = { kind: 'page' as const, gesture: false, widget: false, has };
    expect(callRefusal('bindingsSurface', { name: 'main' }, page)).toBeNull();
    expect(callRefusal('bindingsSurfacePanel', { name: 'main', collapsed: true }, page)).toBeNull();
    for (const kind of ['background', 'program'] as const) expect(callRefusal('bindingsSurface', { name: 'main' }, { kind, has })?.code).toBe('invalid');
    for (const [verb, args] of [['bindingsRead', { name: 'main', path: 'x' }], ['messagesHistory', { chat: CHAT }], ['chatsList', {}],
      ['dispatch', { text: 'x', draft: true, to: { binding: 'main' } }]] as const) expect(callRefusal(verb, args, { ...page, gesture: true })?.code).toBe('denied');
    service.setPermissionGranted(ID, 'chat:surface', false);
    expect(callRefusal('bindingsSurface', { name: 'main' }, page)?.code).toBe('denied');
    expect(callRefusal('bindingsSurfacePanel', { name: 'main', collapsed: true }, page)?.code).toBe('denied');
  });
});

/** #1925 (API 46): the same binding's `work` action — the assistant's work list, and one task drawn in the App's panel. */
function workManifest({ actions = ['unread', 'work'], capabilities, apiVersion = EXTENSION_API_VERSION }: { actions?: string[]; capabilities?: string[]; apiVersion?: number } = {}) {
  const base = manifest();
  return { ...base, apiVersion,
    permissions: { capabilities: capabilities ?? ['chat:unread', ...actions.filter(a => a !== 'unread').map(a => `chat:${a}`)], bindings: [{ name: 'main', kind: 'conversation', actions }] } };
}

describe('the assistant\'s work on the binding (#1925, API 46)', () => {
  it('needs API 46 and the work action with chat:work, each without the other refused; desktop only', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(46);
    expect(() => parseExtensionManifest(workManifest())).not.toThrow();
    expect(() => parseExtensionManifest(surfaceManifest({ actions: ['unread', 'surface', 'work'] }))).not.toThrow();
    for (const apiVersion of [37, 40, 41, 45]) expect(() => parseExtensionManifest(workManifest({ apiVersion }))).toThrow(/apiVersion 46/);
    expect(() => parseExtensionManifest(workManifest({ capabilities: ['chat:unread'] }))).toThrow(/chat:work/);
    expect(() => parseExtensionManifest(workManifest({ actions: ['unread'], capabilities: ['chat:unread', 'chat:work'] }))).toThrow(/chat:work/);
    // No binding at all: there is no conversation to be the assistant's.
    expect(() => parseExtensionManifest({ ...manifest(), permissions: { capabilities: ['chat:work'] } })).toThrow();
    // API 49: a phone takes the binding from 49 (phone-binding.ts), and refuses it before.
    expect(() => parseExtensionManifest({ ...workManifest(), apiVersion: 48, platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest({ ...workManifest(), apiVersion: 49, platforms: ['desktop', 'phone'] })).not.toThrow();
    // An App of before parses as it did.
    expect(() => parseExtensionManifest(boundManifest())).not.toThrow();
  });

  it('reaches the selected conversation only with work declared and chat:work granted; withdrawn, only work stops', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'work')).toThrow(expect.objectContaining({ code: 'denied' }));
    const working = fixture(); working.install(workManifest({ actions: ['unread', 'draft', 'work'] }));
    working.service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(working.service.conversationBinding(OWNER, ID, 'main', 'work')?.chatId).toBe(CHAT);
    expect(working.service.conversationBinding(OTHER, ID, 'main', 'work')).toBeNull();
    expect(working.service.conversationBindingActions(ID)).toEqual(['unread', 'draft', 'work']);
    // chat:work widens nothing else: no messages, no files, no surface, no agents.
    for (const word of ['chat:read', 'chat:files', 'chat:surface', 'files:read', 'chat:relay', 'agents:read', 'agents:control'] as const) expect(working.service.hasCapability(ID, word)).toBe(false);
    const authority = working.service.conversationUnreadAuthority(OWNER, ID, 'main');
    working.service.setPermissionGranted(ID, 'chat:work', false);
    expect(() => working.service.conversationBinding(OWNER, ID, 'main', 'work')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(working.service.conversationBinding(OWNER, ID, 'main', 'draft')?.chatId).toBe(CHAT);
    // A chooser drawn before the change must ask again.
    expect(working.service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    working.service.setPermissionGranted(ID, 'chat:work', true);
    working.service.setEnabled(ID, false);
    expect(() => working.service.conversationBinding(OWNER, ID, 'main', 'work')).toThrow(expect.objectContaining({ code: 'denied' }));
    working.service.setEnabled(ID, true);
    working.service.uninstall(ID);
    expect(() => working.service.conversationBinding(OWNER, ID, 'main', 'work')).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('at the shared door: work and closeWork need chat:work, openWork a click too, all a page\'s; nothing else opens', () => {
    const { service, install } = fixture(); install(workManifest());
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = { kind: 'page' as const, gesture: false, widget: false, has };
    const handle = 'wAAAAAAAAAAAAAAAAAAAAAA';
    expect(callRefusal('bindingsWork', { name: 'main' }, page)).toBeNull();
    expect(callRefusal('bindingsCloseWork', { name: 'main' }, page)).toBeNull();
    expect(callRefusal('bindingsOpenWork', { name: 'main', handle }, page)?.code).toBe('denied');
    expect(callRefusal('bindingsOpenWork', { name: 'main', handle }, { ...page, gesture: true })).toBeNull();
    for (const kind of ['background', 'program'] as const) expect(callRefusal('bindingsWork', { name: 'main' }, { kind, has })?.code).toBe('invalid');
    for (const [verb, args] of [['bindingsRead', { name: 'main', path: 'x' }], ['bindingsSurface', { name: 'main' }], ['messagesHistory', { chat: CHAT }], ['chatsList', {}],
      ['dispatch', { text: 'x', draft: true, to: { binding: 'main' } }]] as const) expect(callRefusal(verb, args, { ...page, gesture: true })?.code).toBe('denied');
    service.setPermissionGranted(ID, 'chat:work', false);
    for (const verb of ['bindingsWork', 'bindingsOpenWork', 'bindingsCloseWork'] as const) expect(callRefusal(verb, { name: 'main', handle }, { ...page, gesture: true })?.code).toBe('denied');
  });
});
