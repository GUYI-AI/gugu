import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';
import { COMPOSER_ACTIONS_API_VERSION } from './composer-actions';

/**
 * #1927 (API 48) What an App may declare for the composer 「+」 of the person's own assistant chat: entries the host draws
 * and runs — a label, an icon from the host's set and one run from a closed set, each run needing its binding action (and so
 * its capability) — from API 48. Nothing in an entry is code, a URL or markup.
 */
const ACTIONS = ['unread', 'draft', 'surface', 'voice-notes:record'];
const CAPABILITY = { unread: 'chat:unread', draft: 'chat:draft', surface: 'chat:surface', 'voice-notes:record': 'chat:voice-notes:record' } as Record<string, string>;
const ideas = { id: 'ideas', label: { zh: '获取灵感', en: 'Get ideas' }, icon: 'sparkles', run: { kind: 'page-intent' } };
const voice = { id: 'voice-note', label: { zh: '录制语音笔记', en: 'Record a voice note' }, icon: 'mic', run: { kind: 'voice-note' } };
const draft = { id: 'ask', label: { zh: '问问它', en: 'Ask it' }, icon: 'message', run: { kind: 'draft', text: { zh: '帮我看看今天的安排。', en: 'Look at my day with me.' } } };

function manifest(composerActions: unknown[] | undefined, options: { actions?: string[]; apiVersion?: number } = {}) {
  const actions = options.actions ?? ACTIONS;
  return {
    id: 'assistant', name: 'Assistant', version: '1.0.0', apiVersion: options.apiVersion ?? EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: actions.map((action) => CAPABILITY[action]), bindings: [{ name: 'main', kind: 'conversation', actions }] },
    contributes: { tabs: [{ name: 'main', title: 'Assistant' }], conversationSurface: { binding: 'main', placement: 'side-panel', ...(composerActions ? { composerActions } : {}) } },
  };
}
const refused = (value: object, problem: RegExp) => expect(() => parseExtensionManifest(value)).toThrow(problem);

describe('composer actions in the manifest', () => {
  it('the three runs, from API 48, labels trimmed', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(COMPOSER_ACTIONS_API_VERSION);
    const parsed = parseExtensionManifest(manifest([ideas, voice, { ...draft, label: { zh: ' 问问它 ', en: 'Ask it' } }]));
    expect(parsed.contributes.conversationSurface?.composerActions?.map((entry) => [entry.id, entry.run.kind, entry.label.zh]))
      .toEqual([['ideas', 'page-intent', '获取灵感'], ['voice-note', 'voice-note', '录制语音笔记'], ['ask', 'draft', '问问它']]);
    expect(() => parseExtensionManifest(manifest(undefined))).not.toThrow();
  });

  it('below its API version: refused', () => {
    for (const apiVersion of [44, COMPOSER_ACTIONS_API_VERSION - 1]) {
      refused(manifest([ideas], { apiVersion }), new RegExp(`composerActions requires apiVersion ${COMPOSER_ACTIONS_API_VERSION}`));
    }
  });

  it('each run needs its binding action: a voice note the recorder, a draft the draft', () => {
    refused(manifest([voice], { actions: ['unread', 'draft', 'surface'] }), /"voice-note" composer action requires the conversation binding's "voice-notes:record" action/);
    refused(manifest([draft], { actions: ['unread', 'surface', 'voice-notes:record'] }), /"draft" composer action requires the conversation binding's "draft" action/);
    expect(() => parseExtensionManifest(manifest([ideas], { actions: ['unread', 'surface'] }))).not.toThrow();
  });

  it('only the host\'s icons, plain one-line labels, at most six, each id once, nothing else in an entry', () => {
    for (const bad of [
      { ...ideas, icon: 'https://example.com/i.png' },
      { ...ideas, icon: '<svg/>' },
      { ...ideas, label: { zh: '获取\n灵感', en: 'Get ideas' } },
      { ...ideas, label: { zh: '获取灵感', en: 'Get \u202eideas' } },
      { ...ideas, label: { zh: '', en: 'Get ideas' } },
      { ...ideas, label: { zh: '获取灵感', en: 'x'.repeat(41) } },
      { ...ideas, label: { en: 'Get ideas' } },
      { ...ideas, label: { zh: '获取灵感', en: 'Get ideas', fr: 'Idées' } },
      { ...ideas, id: 'Ideas!' },
      { ...ideas, onClick: 'alert(1)' },
      { ...ideas, run: { kind: 'script', code: 'alert(1)' } },
      { ...ideas, run: { kind: 'page-intent', data: { chat: 'x' } } },
      { ...ideas, run: { kind: 'page-intent', intent: 'ideas' } },
      { ...draft, run: { kind: 'draft', text: { zh: 'x'.repeat(2001), en: 'x' } } },
      { ...draft, run: { kind: 'draft', text: '帮我看看' } },
      { ...draft, run: { kind: 'draft', text: { zh: '帮我看看' } } },
      { ...draft, run: { kind: 'draft', text: { zh: 'bell\u0007', en: 'x' } } },
      { ...voice, run: { kind: 'voice-note', meeting: { title: 'x' } } },
    ]) refused(manifest([bad]), /./);
    refused(manifest([ideas, { ...draft, id: 'ideas' }]), /each composer action id once/);
    refused(manifest(Array.from({ length: 7 }, (_, at) => ({ ...ideas, id: `ideas-${at}` }))), /./);
    refused(manifest([]), /./);
    // A draft keeps its lines.
    expect(() => parseExtensionManifest(manifest([{ ...draft, run: { kind: 'draft', text: { zh: '第一行\n第二行', en: 'one\ntwo' } } }]))).not.toThrow();
  });

  // Real window (verify-pass1 11-b): the built-in assistant's 「灵感」 capsule above its composer was gone beside the App. An
  // entry may be drawn there too, with a shorter label (`chip`), as 「灵感」 is over 「获取灵感」. Control (the parent commit):
  // `chip` was not a field of an entry (refused as unknown).
  it('`chip`: one entry may also be the capsule above the composer, with a shorter plain label in both languages', () => {
    const chipped = { ...ideas, chip: { zh: '灵感', en: 'Ideas' } };
    const parsed = parseExtensionManifest(manifest([chipped, voice]));
    expect(parsed.contributes.conversationSurface?.composerActions?.map((entry) => entry.chip ?? null)).toEqual([{ zh: '灵感', en: 'Ideas' }, null]);
    refused(manifest([chipped, { ...voice, chip: { zh: '录音', en: 'Record' } }]), /one composer action at most is a chip/);
    for (const chip of [{ zh: '灵感' }, { zh: '灵\n感', en: 'Ideas' }, { zh: '', en: 'Ideas' }, { zh: '灵感', en: 'x'.repeat(41) }, '灵感', { zh: '灵感', en: 'Ideas', icon: 'mic' }]) {
      refused(manifest([{ ...ideas, chip }]), /./);
    }
  });
});
