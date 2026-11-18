import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { addedPermissions } from '@shared/extensions/upgrade';
import { appPlatformProblems } from '@shared/extensions/app-platforms';
import { ExtensionsService } from './extensions-service';

/**
 * #1927 (API 47) The grant behind an App driving the voice-note recorder: what a manifest may declare (the binding's
 * `voice-notes:record` with `chat:voice-notes:record`, apiVersion 47, desktop only), what the installed App's grant
 * answers (withdrawn on its own, failing closed), and the shared door: a page only, a click to start, resume, retry or
 * open the microphone settings.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ID = 'assistant-app';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function manifest(options: { actions?: string[]; capabilities?: string[]; apiVersion?: number; platforms?: string[] } = {}) {
  const actions = options.actions ?? ['unread', 'voice-notes:record'];
  const capabilities = options.capabilities ?? ['chat:unread', ...actions.filter((action) => action !== 'unread').map((action) => `chat:${action}`)];
  return { id: ID, name: 'Assistant', version: '1.0.0', apiVersion: options.apiVersion ?? EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: options.platforms ?? ['desktop'], entry: 'index.html',
    permissions: { capabilities, bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } };
}
function fixture(value: object = manifest()) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-voice-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Assistant</p>');
  const service = new ExtensionsService(path.join(root, 'installed'));
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(value));
  service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: OWNER });
  service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
  return service;
}
const refused = { code: 'denied' };

describe('declaring the recorder (manifest)', () => {
  it('needs API 47, the action with its capability and the binding itself; on a phone API 49, where it answers unsupported', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(47);
    expect(() => parseExtensionManifest(manifest())).not.toThrow();
    expect(() => parseExtensionManifest(manifest({ actions: ['unread', 'resources', 'voice-notes:record'], capabilities: ['chat:unread', 'chat:resources', 'chat:voice-notes:record'] })))
      .toThrow(/domains/);
    for (const apiVersion of [40, 42, 46]) expect(() => parseExtensionManifest(manifest({ apiVersion }))).toThrow(/apiVersion 47/);
    expect(() => parseExtensionManifest(manifest({ capabilities: ['chat:unread'] }))).toThrow(/chat:voice-notes:record/);
    expect(() => parseExtensionManifest(manifest({ actions: ['unread'], capabilities: ['chat:unread', 'chat:voice-notes:record'] }))).toThrow(/chat:voice-notes:record/);
    expect(() => parseExtensionManifest(manifest({ actions: ['voice-notes:record'], capabilities: ['chat:voice-notes:record'] }))).toThrow();
    // A phone takes the binding from 49 (phone-binding.ts); there the recorder's verbs answer `unsupported` (its own 聊天
    // records), so the capability does not keep the assistant App off the phone.
    expect(() => parseExtensionManifest(manifest({ platforms: ['desktop', 'phone'], apiVersion: 48 }))).toThrow(/on a phone requires apiVersion 49/);
    expect(() => parseExtensionManifest(manifest({ platforms: ['desktop', 'phone'], apiVersion: 49 }))).not.toThrow();
    expect(appPlatformProblems(manifest({ platforms: ['desktop', 'phone'], apiVersion: 49 }))).toEqual([]);
  });

  it('adding it in an update is a permission asked for', () => {
    const before = parseExtensionManifest(manifest({ actions: ['unread'], capabilities: ['chat:unread'] }));
    expect(addedPermissions(before, [], parseExtensionManifest(manifest())).capabilities).toEqual(['chat:voice-notes:record']);
  });
});

describe('the installed App\'s recorder grant', () => {
  it('answers the chosen conversation; withdrawn on its own keeps the choice; disabled or uninstalled fails closed', () => {
    const service = fixture();
    expect(service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'voice-notes:record']);
    service.setPermissionGranted(ID, 'chat:voice-notes:record', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')).toThrow(expect.objectContaining(refused));
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId).toBe(CHAT);
    service.setPermissionGranted(ID, 'chat:voice-notes:record', true);
    expect(service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')?.chatId).toBe(CHAT);
    service.setEnabled(ID, false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')).toThrow(expect.objectContaining(refused));
    service.setEnabled(ID, true);
    service.uninstall(ID);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')).toThrow(expect.objectContaining(refused));
  });

  it('withdrawn and given back: a chooser drawn before must ask again (the pending selection does not cross the change)', () => {
    const service = fixture();
    const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).toBe(authority);
    service.setPermissionGranted(ID, 'chat:voice-notes:record', false);
    service.setPermissionGranted(ID, 'chat:voice-notes:record', true);
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
  });

  it('an App without the action has no recorder', () => {
    const service = fixture(manifest({ actions: ['unread'], capabilities: ['chat:unread'] }));
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'voice-notes:record')).toThrow(expect.objectContaining(refused));
  });

  it('at the shared door: a page only; a click to start, resume, retry or open the microphone settings; not to pause, stop or hear', () => {
    const service = fixture();
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const clicked = { kind: 'page' as const, gesture: true, widget: false, has };
    const idle = { kind: 'page' as const, gesture: false, widget: false, has };
    const job = '55000000-0000-4000-8000-000000000005';
    const calls = [['voiceNoteStart', { name: 'main' }], ['voiceNoteResume', { name: 'main' }], ['voiceNoteRetry', { name: 'main', job }],
      ['voiceNoteOpenMicSettings', { name: 'main' }], ['voiceNotePause', { name: 'main' }], ['voiceNoteStop', { name: 'main' }],
      ['voiceNoteStatus', { name: 'main' }], ['voiceNoteWatch', { watchId: '1', name: 'main', on: true }]] as const;
    for (const [verb, args] of calls) {
      expect(callRefusal(verb, args, clicked)).toBeNull();
      const needsClick = ['voiceNoteStart', 'voiceNoteResume', 'voiceNoteRetry', 'voiceNoteOpenMicSettings'].includes(verb);
      expect(callRefusal(verb, args, idle) === null).toBe(!needsClick);
      for (const kind of ['background', 'program'] as const) expect(callRefusal(verb, args, { kind, has })?.code).toBe('invalid');
    }
    service.setPermissionGranted(ID, 'chat:voice-notes:record', false);
    for (const [verb, args] of calls) expect(callRefusal(verb, args, clicked)?.code).toBe('denied');
  });
});
