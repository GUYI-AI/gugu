import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { ExtensionsService } from './extensions-service';

/**
 * #1925 (API 44) The binding's assistant actions as the real service and manifest hold them: each declared with its own
 * capability, on the conversation binding (#1927); consented and withdrawn on its own; failing closed while disabled, after
 * uninstall, for another publisher and across accounts. Which conversation is the person's assistant is checked per call
 * (app-assistant-binding.test.ts).
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ID = 'assistant-app';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function manifest(actions: string[] = ['unread', 'assistant-status', 'assistant-open'], capabilities?: string[], apiVersion = 44) {
  const words = capabilities ?? ['chat:unread', ...actions.filter((action) => action !== 'unread').map((action) => action.replace('assistant-', 'assistant:'))];
  return { id: ID, name: 'Assistant', version: '1.0.0', apiVersion, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: words, bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } };
}
function fixture(value = manifest()) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-assistant-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Assistant</p>');
  const service = new ExtensionsService(path.join(root, 'installed'));
  const install = (next = value, publisher = OWNER) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(next));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: publisher });
  };
  install();
  return { service, install };
}

describe('rename: its own action and capability, from API 44', () => {
  const ALL = ['unread', 'assistant-status', 'assistant-open', 'assistant-rename'];

  it('parses with assistant:rename; an older apiVersion, or the action and the capability apart, is refused', () => {
    expect(() => parseExtensionManifest(manifest(ALL))).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-rename']))).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-rename'], undefined, 43))).toThrow(/"assistant-rename" action requires apiVersion 44/);
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-rename'], ['chat:unread']))).toThrow(/assistant:rename requires/);
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-open'], ['chat:unread', 'assistant:open', 'assistant:rename']))).toThrow(/assistant:rename requires/);
  });

  it('withdrawing assistant:rename stops rename at once and keeps the rest; a chooser drawn before must ask again', () => {
    const { service } = fixture(manifest(ALL)); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-rename')?.chatId).toBe(CHAT);
    const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
    service.setPermissionGranted(ID, 'assistant:rename', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'assistant-rename')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-open')?.chatId).toBe(CHAT);
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
  });

  it('at the shared door: rename needs assistant:rename and a gesture; toast needs neither, only a page', () => {
    const { service } = fixture(manifest(ALL));
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = (gesture = true) => ({ kind: 'page' as const, gesture, widget: false, has });
    expect(callRefusal('assistantRename', { name: 'main', text: 'Pip' }, page())).toBeNull();
    expect(callRefusal('assistantRename', { name: 'main', text: 'Pip' }, page(false))?.code).toBe('denied');
    expect(callRefusal('toast', { text: 'Saved' }, page(false))).toBeNull();
    for (const kind of ['background', 'program'] as const) {
      expect(callRefusal('assistantRename', { name: 'main', text: 'Pip' }, { kind, has })?.code).toBe('invalid');
      expect(callRefusal('toast', { text: 'Saved' }, { kind, has })?.code).toBe('invalid');
    }
    service.setPermissionGranted(ID, 'assistant:rename', false);
    expect(callRefusal('assistantRename', { name: 'main', text: 'Pip' }, page())?.code).toBe('denied');
  });
});

describe('the manifest: assistant actions on the conversation binding, from API 44', () => {
  it('parses at 44 with each action and its capability; an older apiVersion, a mismatch or no binding is refused', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(44);
    expect(() => parseExtensionManifest(manifest())).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-status']))).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-open']))).not.toThrow();
    // Older API: the action is named in the message.
    for (const apiVersion of [37, 40, 43]) {
      expect(() => parseExtensionManifest(manifest(['unread', 'assistant-status'], undefined, apiVersion))).toThrow(/"assistant-status" action requires apiVersion 44/);
      expect(() => parseExtensionManifest(manifest(['unread', 'assistant-open'], undefined, apiVersion))).toThrow(/"assistant-open" action requires apiVersion 44/);
    }
    // An action without its capability, a capability without its action — either way round, and crossed.
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-open'], ['chat:unread']))).toThrow(/assistant:open requires/);
    expect(() => parseExtensionManifest(manifest(['unread'], ['chat:unread', 'assistant:status']))).toThrow(/assistant:status requires/);
    expect(() => parseExtensionManifest(manifest(['unread', 'assistant-status'], ['chat:unread', 'assistant:open']))).toThrow(/assistant:(status|open) requires/);
    // The binding itself is still `unread` with `chat:unread`; no binding, no assistant.
    expect(() => parseExtensionManifest(manifest(['assistant-status'], ['chat:unread', 'assistant:status']))).toThrow();
    expect(() => parseExtensionManifest({ ...manifest(), permissions: { capabilities: ['assistant:status', 'assistant:open'] } })).toThrow();
    for (const actions of [['unread', 'assistant-status', 'assistant-status'], ['unread', 'assistant'], ['unread', 'assistant-close'], ['unread', 'assistant-settings']]) {
      expect(() => parseExtensionManifest(manifest(actions, ['chat:unread', 'assistant:status']))).toThrow();
    }
    expect(() => parseExtensionManifest({ ...manifest(), platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
  });

  it('an App of API 40 with files and draft parses as before', () => {
    const before = { ...manifest(['unread', 'files', 'draft'], ['chat:unread', 'chat:files', 'chat:draft'], 40) };
    expect(() => parseExtensionManifest(before)).not.toThrow();
  });
});

describe('the service: each assistant grant on its own, failing closed', () => {
  it('reaches the selection only with the action declared and its capability granted; nothing wider comes with it', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-status')?.chatId).toBe(CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-open')?.chatId).toBe(CHAT);
    expect(service.conversationBinding(OTHER, ID, 'main', 'assistant-open')).toBeNull();
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'assistant-status', 'assistant-open']);
    for (const word of ['chat:read', 'chat:files', 'chat:draft', 'files:read', 'agents:read', 'agents:control', 'chat:relay'] as const) expect(service.hasCapability(ID, word)).toBe(false);
    // An App that declares only status has no open.
    const statusOnly = fixture(manifest(['unread', 'assistant-status'])); statusOnly.service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    expect(() => statusOnly.service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('withdrawing assistant:open stops open and advanceSetup at once and keeps status; a chooser drawn before must ask again', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
    service.setPermissionGranted(ID, 'assistant:open', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-status')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'assistant-status']);
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    service.setPermissionGranted(ID, 'assistant:status', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'assistant-status')).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('withdrawing chat:unread takes the assistant actions with the selection; restored, nothing comes back without a new choice', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setPermissionGranted(ID, 'chat:unread', false);
    for (const action of ['assistant-status', 'assistant-open'] as const) expect(() => service.conversationBinding(OWNER, ID, 'main', action)).toThrow();
    service.setPermissionGranted(ID, 'chat:unread', true);
    for (const action of ['assistant-status', 'assistant-open'] as const) expect(service.conversationBinding(OWNER, ID, 'main', action)).toBeNull();
  });

  it('fails closed while disabled and after uninstall; a reinstall or another publisher needs a new choice', () => {
    const { service, install } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setEnabled(ID, false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toThrow(expect.objectContaining({ code: 'denied' }));
    service.setEnabled(ID, true);
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-open')?.chatId).toBe(CHAT);
    service.uninstall(ID);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toThrow(expect.objectContaining({ code: 'denied' }));
    install();
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(manifest(), OTHER);
    expect(service.conversationBinding(OWNER, ID, 'main', 'assistant-status')).toBeNull();
    // An upgrade that adds an assistant action is a new declaration: the person chooses again.
    const unreadOnly = fixture(manifest(['unread'], ['chat:unread'])); unreadOnly.service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    unreadOnly.install(manifest());
    expect(unreadOnly.service.conversationBinding(OWNER, ID, 'main', 'assistant-open')).toBeNull();
  });

  it('at the shared door: status needs assistant:status; open and advanceSetup need assistant:open and a gesture; nothing else opens', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = (gesture = true) => ({ kind: 'page' as const, gesture, widget: false, has });
    expect(callRefusal('assistantStatus', { name: 'main' }, page(false))).toBeNull();
    expect(callRefusal('assistantOpen', { name: 'main', screen: 'close' }, page())).toBeNull();
    expect(callRefusal('assistantAdvanceSetup', { name: 'main', next: 'ready' }, page())).toBeNull();
    expect(callRefusal('assistantOpen', { name: 'main', screen: 'close' }, page(false))?.code).toBe('denied');
    expect(callRefusal('assistantAdvanceSetup', { name: 'main', next: 'ready' }, page(false))?.code).toBe('denied');
    for (const kind of ['background', 'program'] as const) {
      expect(callRefusal('assistantStatus', { name: 'main' }, { kind, has })?.code).toBe('invalid');
      expect(callRefusal('assistantOpen', { name: 'main', screen: 'close' }, { kind, has })?.code).toBe('invalid');
    }
    for (const [verb, args] of [['bindingsRead', { name: 'main', path: 'today.json' }], ['messagesHistory', { chat: CHAT }], ['chatsList', {}], ['stopAgent', { agentId: 'x' }]] as const) {
      expect(callRefusal(verb, args, page())?.code).toBe('denied');
    }
    service.setPermissionGranted(ID, 'assistant:status', false);
    service.setPermissionGranted(ID, 'assistant:open', false);
    expect(callRefusal('assistantStatus', { name: 'main' }, page())?.code).toBe('denied');
    expect(callRefusal('assistantOpen', { name: 'main', screen: 'close' }, page())?.code).toBe('denied');
    expect(callRefusal('assistantAdvanceSetup', { name: 'main', next: 'ready' }, page())?.code).toBe('denied');
  });
});
