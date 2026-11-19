// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  // The bar measures the composer row it sits above; jsdom has no layout.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

/**
 * #1927 (API 48) The host's recording bar in the column of an App placed beside the person's own assistant chat: the
 * built-in bar itself (VoiceBar, real here), over a fake recorder and notes — shown while that column is this account's
 * assistant chat and the recorder's notes go to that assistant, whichever side started the recording; gone when it is idle
 * with nothing to show, for another conversation, another account or assistant. Opening the note it shows tells main, which
 * tells the App's page; nothing else of it goes anywhere.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OTHER_CHAT = '44000000-0000-4000-8000-000000000004';
const AGENT = 'assistant-agent';
type Snapshot = { phase: string; elapsedMs: number; level: number; silentMs: number; error: string | null };
const state = vi.hoisted(() => ({
  shell: null as null | { chatId: string | null; ownerId: string | null; assistant: { id: string; display_name: string } | null },
  context: null as string | null,
  contextListeners: new Set<() => void>(),
  recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null } as Snapshot,
  recorderListeners: new Set<() => void>(),
  jobs: [] as Record<string, unknown>[],
  activated: 0,
  dismissed: [] as string[],
  opened: [] as unknown[],
  calls: [] as string[],
}));
const fire = (listeners: Set<() => void>) => { for (const listener of [...listeners]) listener(); };
vi.mock('@renderer/lib/ipc', async (original) => ({
  ...(await original<object>()),
  rpc: { extensions: { conversationVoiceNoteOpened: async (args: unknown) => { state.opened.push(args); return { success: true, data: { told: true } }; } } },
  invokeOnMachine: vi.fn(),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => state.shell }));
vi.mock('@renderer/features/assistant/assistant-data', () => ({ assistantQueryKey: () => ['assistant'] }));
vi.mock('@renderer/features/assistant/voice-notes/app-voice-notes-active', () => ({ appVoiceNotesActive: { activate: () => { state.activated += 1; } } }));
vi.mock('@renderer/features/assistant/voice-notes/voice-recorder', () => ({ voiceRecorder: {
  getSnapshot: () => state.recorder,
  subscribe: (listener: () => void) => { state.recorderListeners.add(listener); return () => state.recorderListeners.delete(listener); },
  get busy() { return state.recorder.phase !== 'idle'; },
  pause: () => state.calls.push('pause'), resume: () => state.calls.push('resume'), stop: () => state.calls.push('stop'),
  cancel: () => state.calls.push('cancel'), clearError: () => undefined,
} }));
vi.mock('@renderer/features/assistant/voice-notes/voice-notes-data', () => ({ useVoiceJobs: () => state.jobs, failureText: () => 'failed' }));
vi.mock('@renderer/features/assistant/voice-notes/voice-note-jobs', () => ({
  voiceJobs: { dismiss: (id: string) => state.dismissed.push(id) },
  retryVoiceNote: vi.fn(), startVoiceNote: vi.fn(), setVoiceNotesContext: vi.fn(),
  voiceNotesAssistantId: () => state.context,
  subscribeVoiceNotesContext: (listener: () => void) => { state.contextListeners.add(listener); return () => state.contextListeners.delete(listener); },
}));

const { default: AppConversationVoiceBar } = await import('./app-conversation-voice-bar');

let root: Root;
let column: HTMLDivElement;
const render = (chatId = CHAT) => act(async () => root.render(<AppConversationVoiceBar extensionId="assistant-app" chatId={chatId} column={column} />));
const bar = () => column.ownerDocument.querySelector('[data-testid="assistant-voice-bar"]');
const record = (patch: Partial<Snapshot>) => act(async () => { state.recorder = { ...state.recorder, ...patch }; fire(state.recorderListeners); });

beforeEach(() => {
  Object.assign(state, {
    shell: { chatId: CHAT, ownerId: 'owner-a', assistant: { id: AGENT, display_name: 'Mochi' } }, context: AGENT,
    recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null }, jobs: [], activated: 0, dismissed: [], opened: [], calls: [],
  });
  column = document.createElement('div');
  document.body.append(column);
  root = createRoot(column);
});
afterEach(async () => {
  await act(async () => root.unmount());
  column.remove();
});

describe('the recording bar beside an App\'s assistant chat', () => {
  it('shown while it records, paused or stopping; its controls the recorder\'s; gone when idle with nothing to show', async () => {
    await render();
    expect(state.activated).toBe(1);
    expect(bar()).toBeNull();
    await record({ phase: 'recording', elapsedMs: 4_000, level: 0.4 });
    expect(bar()?.getAttribute('data-phase')).toBe('recording');
    expect(column.hasAttribute('data-voice-bar')).toBe(true);
    await act(async () => (column.querySelector('[data-testid="assistant-voice-bar-pause"]') as HTMLButtonElement).click());
    await record({ phase: 'paused' });
    expect(bar()?.getAttribute('data-phase')).toBe('paused');
    await act(async () => (column.querySelector('[data-testid="assistant-voice-bar-stop"]') as HTMLButtonElement).click());
    expect(state.calls).toEqual(['pause', 'stop']);
    await record({ phase: 'idle' });
    expect(bar()).toBeNull();
    expect(column.hasAttribute('data-voice-bar')).toBe(false);
  });

  it('whichever side started it: a recording already going when the column is drawn shows at once', async () => {
    state.recorder = { phase: 'recording', elapsedMs: 1_000, level: 0.2, silentMs: 0, error: null };
    await render();
    expect(bar()?.getAttribute('data-phase')).toBe('recording');
  });

  it('a note being made, then made: opening it takes the bar away and tells main for this account and App only', async () => {
    state.jobs = [{ id: '20261111-0100-ab12', phase: 'transcribing', failure: null, title: null, dismissed: false, createdAt: new Date().toISOString() }];
    await render();
    expect(bar()?.getAttribute('data-phase')).toBe('transcribing');
    state.jobs = [{ ...state.jobs[0], phase: 'ready' }];
    await render();
    await act(async () => (column.querySelector('[data-testid="assistant-voice-bar-open"]') as HTMLButtonElement).click());
    expect(state.dismissed).toEqual(['20261111-0100-ab12']);
    expect(state.opened).toEqual([{ ownerId: 'owner-a', extensionId: 'assistant-app' }]);
    expect(JSON.stringify(state.opened)).not.toContain('20261111');
  });

  it('not drawn for another conversation, another account\'s or no assistant, or a recorder whose notes go elsewhere', async () => {
    state.recorder = { phase: 'recording', elapsedMs: 1_000, level: 0.2, silentMs: 0, error: null };
    await render(OTHER_CHAT);
    expect(bar()).toBeNull();
    expect(state.activated).toBe(0);
    for (const shell of [{ chatId: OTHER_CHAT, ownerId: 'owner-b', assistant: { id: 'theirs', display_name: 'B' } }, { chatId: CHAT, ownerId: 'owner-a', assistant: null }, null]) {
      state.shell = shell;
      await render();
      expect(bar()).toBeNull();
    }
    state.shell = { chatId: CHAT, ownerId: 'owner-a', assistant: { id: AGENT, display_name: 'Mochi' } };
    state.context = 'another-agent';
    await render();
    expect(bar()).toBeNull();
    // Its notes come to go to this assistant: shown.
    await act(async () => { state.context = AGENT; fire(state.contextListeners); });
    expect(bar()?.getAttribute('data-phase')).toBe('recording');
    // The account switched (its shell now another's): gone.
    state.shell = { chatId: OTHER_CHAT, ownerId: 'owner-b', assistant: { id: 'theirs', display_name: 'B' } };
    await render();
    expect(bar()).toBeNull();
  });
});
