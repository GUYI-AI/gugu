import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages';
import enUSAssistant from '@/i18n/locales/en-US/assistant';
import zhCNAssistant from '@/i18n/locales/zh-CN/assistant';
import { consentPrompt, describeCapability, describePermissions, type SessionTranslate } from './extension-consent';

/**
 * #1927 (42) The consent for an agent's resources names the kinds this App lists for each action — those and no others, in
 * the words the assistant's own pages use for them — and an update listing more asks for them again.
 */
const say = (messages: Record<string, string>) => ((key: string, params: Record<string, string> = {}) =>
  messages[key]!.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`)) as SessionTranslate;

function app(domains: { resources: string[]; 'resources:write'?: string[] }) {
  const actions = ['unread', 'resources', ...(domains['resources:write'] ? ['resources:write'] : [])];
  return parseExtensionManifest({ id: 'assistant', name: 'Assistant', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: ['chat:unread', ...actions.slice(1).map((action) => `chat:${action}`)],
      bindings: [{ name: 'main', kind: 'conversation', actions, domains }] },
    contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } });
}

describe('consent for an agent\'s resources', () => {
  it('names only the kinds this App lists, per action, in the assistant pages\' words and one order', () => {
    const manifest = app({ resources: ['voice-notes', 'memory'], 'resources:write': ['memory'] });
    expect(describeCapability('chat:resources', manifest, say(enUSMessages)))
      .toBe(`Read only what your agent keeps in the conversation you select: ${enUSAssistant.resourceKinds.memory}, ${enUSAssistant.resourceKinds['voice-notes']}`);
    expect(describeCapability('chat:resources:write', manifest, say(enUSMessages)))
      .toBe(`Change what your agent keeps in the conversation you select: ${enUSAssistant.resourceKinds.memory}; your agent applies the changes`);
    expect(describeCapability('chat:resources', manifest, say(zhCNMessages))).toBe('只读取你选定的那条会话里 agent 记着的记忆、语音笔记');
    expect(describeCapability('chat:resources:write', manifest, say(zhCNMessages))).toBe('改动你选定的那条会话里 agent 记着的记忆，由 agent 照改');
    for (const messages of [enUSMessages, zhCNMessages]) {
      const text = describePermissions(manifest, say(messages));
      const labels = messages === enUSMessages ? enUSAssistant.resourceKinds : zhCNAssistant.resourceKinds;
      for (const unlisted of ['files', 'personality', 'skills'] as const) expect(text).not.toContain(labels[unlisted]);
    }
  });

  it('an update listing more asks again, naming what it now lists; fewer asks nothing', () => {
    const installed = app({ resources: ['memory'] });
    const wider = consentPrompt(installed, [], app({ resources: ['memory', 'skills'] }), say(enUSMessages), 'en');
    expect(wider.description).toContain(`: ${enUSAssistant.resourceKinds.memory}, ${enUSAssistant.resourceKinds.skills}`);
    const writes = consentPrompt(installed, [], app({ resources: ['memory'], 'resources:write': ['memory'] }), say(enUSMessages), 'en');
    expect(writes.description).toContain('Change what your agent keeps');
    expect(writes.description).not.toContain('Read only');
    const narrower = consentPrompt(app({ resources: ['memory', 'skills'] }), [], installed, say(enUSMessages), 'en');
    expect(narrower.description).toBe(enUSMessages['extensions.updateNothingNew']);
  });
});

describe('#50 consent for managing voice notes', () => {
  it('its own row, in both languages, saying each delete is the person\'s to confirm', () => {
    const manifest = parseExtensionManifest({ id: 'assistant', name: 'Assistant', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'], entry: 'index.html',
      permissions: { capabilities: ['chat:unread', 'chat:resources', 'chat:voice-notes:manage'],
        bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'resources', 'voice-notes:manage'], domains: { resources: ['voice-notes'] } }] },
      contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } });
    expect(describeCapability('chat:voice-notes:manage', manifest, say(enUSMessages)))
      .toBe('Transcribe, export or delete the voice notes your agent keeps in the conversation you select; you confirm each delete');
    expect(describeCapability('chat:voice-notes:manage', manifest, say(zhCNMessages))).toBe('转写、导出或删除你选定的那条会话里 agent 记着的语音笔记，每次删除都由你确认');
    for (const messages of [enUSMessages, zhCNMessages]) expect(describePermissions(manifest, say(messages))).toContain(messages['extensions.permissionsChatVoiceNotesManage']);
  });
});
