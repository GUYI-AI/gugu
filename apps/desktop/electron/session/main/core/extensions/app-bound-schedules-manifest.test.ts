import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { BOUND_SCHEDULES_API_VERSION } from '@shared/extensions/bound-schedules';
import { BINDING_ACTION_API_VERSION } from '@shared/extensions/unread-binding';
import { ExtensionsService } from './extensions-service';

/** #1928 (API 43): the binding's `schedules` / `schedules:control` actions, declared, consented and withdrawn one by one. */
const OWNER = '11000000-0000-4000-8000-000000000001';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ID = 'routines';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const capabilityOf = (action: string) => (action === 'unread' ? 'chat:unread' : `chat:${action}`);
function manifest(actions: string[] = ['unread', 'schedules', 'schedules:control'], capabilities = actions.map(capabilityOf), apiVersion = 43) {
  return { id: ID, name: 'Routines', version: '1.0.0', apiVersion, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities, bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'main', title: 'Routines' }] } };
}
function fixture(value = manifest()) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-schedules-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Routines</p>');
  const service = new ExtensionsService(path.join(root, 'installed'));
  const install = (next = value) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(next));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: OWNER });
  };
  install();
  service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
  return { service, install };
}

describe('the bound agent\'s schedules in the manifest (#1928, API 43)', () => {
  it('needs API 43, each action with its own capability, and control only with inspection', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(43);
    // The binding table spells 43 out (bound-schedules.ts imports from it); it must stay this module's version.
    expect([BINDING_ACTION_API_VERSION.schedules, BINDING_ACTION_API_VERSION['schedules:control']]).toEqual([BOUND_SCHEDULES_API_VERSION, BOUND_SCHEDULES_API_VERSION]);
    expect(() => parseExtensionManifest(manifest())).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules']))).not.toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'files', 'schedules', 'draft', 'schedules:control']))).not.toThrow();
    for (const apiVersion of [40, 41, 42]) {
      expect(() => parseExtensionManifest(manifest(['unread', 'schedules'], undefined, apiVersion))).toThrow(/apiVersion 43/);
      expect(() => parseExtensionManifest(manifest(undefined, undefined, apiVersion))).toThrow(/apiVersion 43/);
    }
    // An action without its capability, a capability without its action, control without inspection.
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules'], ['chat:unread']))).toThrow(/chat:schedules/);
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules'], ['chat:unread', 'chat:schedules', 'chat:schedules:control']))).toThrow(/chat:schedules:control/);
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules', 'schedules:control'], ['chat:unread', 'chat:schedules']))).toThrow(/chat:schedules:control/);
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules:control']))).toThrow(/"schedules" action/);
    // Without the binding itself, twice, or on a phone.
    expect(() => parseExtensionManifest(manifest(['schedules'], ['chat:schedules']))).toThrow();
    expect(() => parseExtensionManifest(manifest(['unread', 'schedules', 'schedules']))).toThrow();
    expect(() => parseExtensionManifest({ ...manifest(), permissions: { capabilities: ['chat:schedules'] } })).toThrow();
    expect(() => parseExtensionManifest({ ...manifest(), platforms: ['desktop', 'phone'] })).toThrow(/on a phone requires apiVersion 49/);
  });

  it('each action reaches the one selection only while declared and granted; withdrawing one keeps the other and the selection', () => {
    const { service } = fixture();
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules')?.chatId).toBe(CHAT);
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules:control')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'schedules', 'schedules:control']);
    // Neither is Agent control, chat reading or files.
    for (const word of ['agents:control', 'agents:read', 'chat:read', 'files:read'] as const) expect(service.hasCapability(ID, word)).toBe(false);
    const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
    service.setPermissionGranted(ID, 'chat:schedules:control', false);
    expect(() => service.conversationBinding(OWNER, ID, 'main', 'schedules:control')).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules')?.chatId).toBe(CHAT);
    expect(service.conversationBindingActions(ID)).toEqual(['unread', 'schedules']);
    // A chooser drawn before the grant changed must ask again.
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    service.setPermissionGranted(ID, 'chat:schedules:control', true);
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules:control')?.chatId).toBe(CHAT);
    // Declared to inspect only: control is no grant to have.
    const inspect = fixture(manifest(['unread', 'schedules']));
    expect(() => inspect.service.conversationBinding(OWNER, ID, 'main', 'schedules:control')).toThrow(expect.objectContaining({ code: 'denied' }));
  });

  it('fails closed while disabled, after uninstall and when an upgrade adds the actions', () => {
    const { service, install } = fixture();
    service.setEnabled(ID, false);
    for (const action of ['schedules', 'schedules:control'] as const) expect(() => service.conversationBinding(OWNER, ID, 'main', action)).toThrow(expect.objectContaining({ code: 'denied' }));
    service.setEnabled(ID, true);
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules')?.chatId).toBe(CHAT);
    service.uninstall(ID);
    for (const action of ['schedules', 'schedules:control'] as const) expect(() => service.conversationBinding(OWNER, ID, 'main', action)).toThrow(expect.objectContaining({ code: 'denied' }));
    install();
    expect(service.conversationBinding(OWNER, ID, 'main', 'schedules')).toBeNull();
    // An unread-only selection does not carry over to a version that adds schedules: the person chooses again.
    const unreadOnly = fixture(manifest(['unread'], ['chat:unread'], 40));
    unreadOnly.install(manifest());
    expect(unreadOnly.service.conversationBinding(OWNER, ID, 'main', 'schedules')).toBeNull();
  });

  it('at the shared door: a page\'s verbs, each behind its own word; no gesture asked', () => {
    const { service } = fixture();
    const has = (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word);
    const page = { kind: 'page' as const, gesture: false, widget: false, has };
    const control = { name: 'main', operationId: 'op-000001', op: 'pause', scheduleId: 'schedule:x', revision: 'r' };
    expect(callRefusal('bindingsSchedules', { name: 'main' }, page)).toBeNull();
    expect(callRefusal('bindingsSchedulesWatch', { name: 'main', on: true }, page)).toBeNull();
    expect(callRefusal('bindingsScheduleControl', control, page)).toBeNull();
    for (const kind of ['background', 'program'] as const) {
      for (const verb of ['bindingsSchedules', 'bindingsSchedulesWatch', 'bindingsScheduleControl']) expect(callRefusal(verb, control, { kind, has })?.code).toBe('invalid');
    }
    // Neither opens Agent control, another chat's messages or files.
    for (const [verb, args] of [['stopAgent', { agentId: 'user:x' }], ['messagesHistory', { chat: CHAT }], ['filesList', { place: { chat: CHAT } }]] as const) {
      expect(callRefusal(verb, args, page)?.code).toBe('denied');
    }
    service.setPermissionGranted(ID, 'chat:schedules', false);
    expect(callRefusal('bindingsSchedules', { name: 'main' }, page)?.code).toBe('denied');
    expect(callRefusal('bindingsSchedulesWatch', { name: 'main', on: true }, page)?.code).toBe('denied');
    expect(callRefusal('bindingsScheduleControl', control, page)).toBeNull();
    service.setPermissionGranted(ID, 'chat:schedules:control', false);
    expect(callRefusal('bindingsScheduleControl', control, page)?.code).toBe('denied');
  });
});
