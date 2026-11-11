import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (47) The bridge's door for the voice-note recorder: the App is the one the call came from, never one it names;
 * `chat:voice-notes:record` is asked at the door, and a click for start / resume / retry / the microphone settings; only a
 * page the person works reaches it — a page an agent works is not that person. A watch's events go to the page that
 * asked, and its page going takes the watch with it. What happens past the door is app-voice-notes.test.ts's.
 */
const granted = new Set<string>();
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'assistant', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({}),
    isEnabled: () => true,
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    grantedCapabilities: () => [...granted],
  }),
}));
const verbs = vi.hoisted(() => ({
  appVoiceNoteStart: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' })),
  appVoiceNote: vi.fn(async (_verb: string, _id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' })),
  appVoiceNoteRetry: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' })),
  appVoiceNoteOpenMicSettings: vi.fn(async () => undefined),
  appVoiceNoteWatch: vi.fn(async (_id: string, _page: number, args: { name: string }, hear: (watchId: string, event: unknown) => void) => {
    hear('1', { name: args.name, state: 'ended' });
    return { name: args.name, state: 'watching' };
  }),
}));
vi.mock('./app-voice-notes', () => verbs);
const stopped = vi.hoisted(() => [] as number[]);
vi.mock('./app-voice-note-watches', () => ({ stopVoiceWatches: (pageId: number) => stopped.push(pageId) }));
const { answerCall, stopPageWatches } = await import('./extension-bridge');

const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, gesture = true, hear = vi.fn()) => ({
  kind: 'page', extensionId: 'assistant', pageId: 41, gesture, filePage: () => ({}), hear,
  binding: { extensionId: 'assistant', operator, conversation: null, widget: null, surface: null },
}) as never;
const JOB = '55000000-0000-4000-8000-000000000005';
const calls: [string, Record<string, unknown>][] = [
  ['voiceNoteStart', { name: 'main', meeting: { title: 'Standup', start: '2026-11-11T09:00:00Z', end: null } }],
  ['voiceNotePause', { name: 'main' }], ['voiceNoteResume', { name: 'main' }], ['voiceNoteStop', { name: 'main' }],
  ['voiceNoteRetry', { name: 'main', job: JOB }], ['voiceNoteOpenMicSettings', { name: 'main' }], ['voiceNoteStatus', { name: 'main' }],
];
const WATCH = { watchId: '1', name: 'main', on: true };

beforeEach(() => {
  granted.clear();
  for (const fn of Object.values(verbs)) fn.mockClear();
  stopped.length = 0;
});

describe('the bridge door for the voice-note recorder', () => {
  it('a person\'s page with the grant reaches it, as the App the call came from', async () => {
    granted.add('chat:voice-notes:record');
    for (const [verb, args] of calls) expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: true });
    expect(verbs.appVoiceNoteStart).toHaveBeenCalledExactlyOnceWith('assistant', calls[0]![1]);
    expect(verbs.appVoiceNote.mock.calls.map(([verb]) => verb)).toEqual(['pause', 'resume', 'stop', 'status']);
    expect(verbs.appVoiceNoteRetry).toHaveBeenCalledExactlyOnceWith('assistant', { name: 'main', job: JOB });
    expect(verbs.appVoiceNoteOpenMicSettings).toHaveBeenCalledExactlyOnceWith('assistant', { name: 'main' });
    const hear = vi.fn();
    expect(await answerCall(page({ kind: 'person' }, false, hear), 'voiceNoteWatch', WATCH)).toEqual({ ok: true, value: { name: 'main', state: 'watching' } });
    expect(verbs.appVoiceNoteWatch).toHaveBeenCalledWith('assistant', 41, WATCH, expect.any(Function));
    expect(hear).toHaveBeenCalledExactlyOnceWith({ type: 'voiceNote', watchId: '1', event: { name: 'main', state: 'ended' } });
    stopPageWatches(41);
    expect(stopped).toEqual([41]);
  });

  it('needs chat:voice-notes:record, and a click to start, resume, retry or open the settings; an agent\'s page, a background page and a program reach nothing', async () => {
    granted.add('chat:unread'); granted.add('chat:resources');
    for (const [verb, args] of [...calls, ['voiceNoteWatch', WATCH] as const]) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:voice-notes:record') });
    }
    granted.add('chat:voice-notes:record');
    for (const verb of ['voiceNoteStart', 'voiceNoteResume', 'voiceNoteRetry', 'voiceNoteOpenMicSettings']) {
      expect(await answerCall(page({ kind: 'person' }, false), verb, calls.find(([name]) => name === verb)![1])).toMatchObject({ ok: false });
    }
    for (const [verb, args] of [...calls, ['voiceNoteWatch', WATCH] as const]) {
      expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), verb, args)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'assistant', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false });
      }
    }
    for (const fn of Object.values(verbs)) expect(fn).not.toHaveBeenCalled();
  });
});
