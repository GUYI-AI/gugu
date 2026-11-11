import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { CAPABILITY_RISK } from '@shared/extensions/catalog';
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages';
import { describeCapability, type SessionTranslate } from './extension-consent';

/** #1927 (47) The consent for the voice-note recorder: one true, terse sentence — the host records when the person clicks. */
const say = (messages: Record<string, string>) => ((key: string, params: Record<string, string> = {}) =>
  messages[key]!.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`)) as SessionTranslate;
const app = parseExtensionManifest({ id: 'assistant', name: 'Assistant', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  platforms: ['desktop'], entry: 'index.html',
  permissions: { capabilities: ['chat:unread', 'chat:voice-notes:record'], bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'voice-notes:record'] }] },
  contributes: { tabs: [{ name: 'main', title: 'Assistant' }] } });

describe('consent for the voice-note recorder', () => {
  it('says the microphone, the click, the conversation chosen, and that the App never gets the audio', () => {
    expect(describeCapability('chat:voice-notes:record', app, say(enUSMessages)))
      .toBe('Record voice notes from your microphone when you click, for your agent in the conversation you select; the App never gets the audio');
    expect(describeCapability('chat:voice-notes:record', app, say(zhCNMessages))).toBe('你点了才用麦克风录语音笔记，交给你选定的那条会话里的 agent；App 拿不到录音');
  });

  it('is a high-risk word', () => {
    expect(CAPABILITY_RISK['chat:voice-notes:record']).toBe('high');
  });
});
