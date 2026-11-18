import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #50 The bridge's door for managing the bound conversation's agent resources: the App is the one the call came from;
 * `chat:resources:write` / `chat:voice-notes:manage` are asked at the door, and a click for what reaches the person's
 * screen (the picker, the question before a delete, the pipeline, the save dialog); only a page the person works reaches
 * them, with its own embedder — never one the App names. What happens past the door is app-bound-resources-manage.test.ts's.
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
const verbs = vi.hoisted(() => {
  const answer = (state: string) => vi.fn(async (..._args: unknown[]) => ({ name: 'main', state }));
  return {
    appResourceUpload: answer('cancelled'), appResourceCreateFolder: answer('exists'), appResourceRename: answer('missing'),
    appResourceRemoveFolder: answer('cancelled'), appVoiceNoteTranscribe: answer('not-waiting'), appVoiceNoteRemove: answer('cancelled'),
    appVoiceNoteExport: answer('cancelled'),
  };
});
vi.mock('./app-bound-resources-manage', () => verbs);
const { answerCall } = await import('./extension-bridge');

const EMBEDDER = 12;
const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, gesture = true) => ({
  kind: 'page', extensionId: 'assistant', pageId: 41, gesture, filePage: () => ({}), hear: vi.fn(),
  binding: { extensionId: 'assistant', operator, conversation: null, widget: null, surface: null, embedderId: EMBEDDER },
}) as never;
const key = { name: 'main', key: 'docs', extensionId: 'someone-else', embedderId: 99 };
// [verb, args, handler, capability, takes the page's embedder, needs a click]
const calls: [string, Record<string, unknown>, keyof typeof verbs, string, boolean, boolean][] = [
  ['bindingsUpload', { name: 'main', folder: 'docs' }, 'appResourceUpload', 'chat:resources:write', true, true],
  ['bindingsCreateFolder', key, 'appResourceCreateFolder', 'chat:resources:write', false, false],
  ['bindingsRename', { ...key, to: 'papers' }, 'appResourceRename', 'chat:resources:write', false, false],
  ['bindingsRemoveFolder', key, 'appResourceRemoveFolder', 'chat:resources:write', true, true],
  ['bindingsTranscribeVoiceNote', key, 'appVoiceNoteTranscribe', 'chat:voice-notes:manage', true, true],
  ['bindingsRemoveVoiceNote', key, 'appVoiceNoteRemove', 'chat:voice-notes:manage', true, true],
  ['bindingsExportVoiceNote', key, 'appVoiceNoteExport', 'chat:voice-notes:manage', true, true],
];

beforeEach(() => {
  granted.clear();
  for (const fn of Object.values(verbs)) fn.mockClear();
});

describe('the bridge door for managing the agent\'s resources', () => {
  it('a person\'s page with the grant reaches them, as the App the call came from, with its own embedder', async () => {
    granted.add('chat:resources:write'); granted.add('chat:voice-notes:manage');
    for (const [verb, args, handler, , embedded] of calls) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: true });
      if (embedded) expect(verbs[handler]).toHaveBeenCalledExactlyOnceWith('assistant', EMBEDDER, args);
      else expect(verbs[handler]).toHaveBeenCalledExactlyOnceWith('assistant', args);
    }
  });

  it('each needs its capability; the ones reaching the person\'s screen need a click', async () => {
    for (const [verb, args, , capability] of calls) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining(capability) });
    }
    granted.add('chat:resources:write'); granted.add('chat:voice-notes:manage');
    for (const [verb, args, , , , click] of calls) {
      const answer = await answerCall(page({ kind: 'person' }, false), verb, args);
      if (click) expect(answer).toMatchObject({ ok: false });
      else expect(answer).toMatchObject({ ok: true });
    }
    expect(verbs.appResourceUpload).not.toHaveBeenCalled();
    expect(verbs.appResourceRemoveFolder).not.toHaveBeenCalled();
    expect(verbs.appVoiceNoteRemove).not.toHaveBeenCalled();
  });

  it('a page an agent works, a background page and a program reach none of them', async () => {
    granted.add('chat:resources:write'); granted.add('chat:voice-notes:manage');
    for (const [verb, args] of calls) {
      expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), verb, args)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'assistant', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false });
      }
    }
    for (const fn of Object.values(verbs)) expect(fn).not.toHaveBeenCalled();
  });
});
