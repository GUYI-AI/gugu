import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVoiceNoteView, VoiceNoteWindowRequest } from '@shared/extensions/voice-note-session';

/**
 * #1927 (API 47) An App driving the host's voice-note recorder, main's half: the authority (the account's own selection
 * for this installed App, `voice-notes:record` granted, the bound conversation its private one with its personal
 * assistant, all checked again after every wait), what the window may say back (the allow-list), and what outlives a
 * call — the recording an App started (stopped and kept once that App loses its grant) and who hears the recorder.
 * The window (app-voice-note-core.ts) is a fake here; its own tests are beside it.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AGENT = '44000000-0000-4000-8000-000000000004';
const JOB = '55000000-0000-4000-8000-000000000005';
const RESEARCHER = '66000000-0000-4000-8000-000000000006';
const ASSISTANT = { agent_user_id: AGENT, member_key: 'assistant', device_id: 'home-device', phase: 'completed', created_at: '2026-11-01T00:00:00Z',
  dm_chat_id: CHAT, agent: { owner_user_id: OWNER, removed_at: null } };
const IDLE: AppVoiceNoteView = { recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null }, jobs: [] };
const RECORDING: AppVoiceNoteView = { recorder: { phase: 'recording', elapsedMs: 1200, level: 0.4, silentMs: 0, error: null },
  jobs: [{ job: JOB, phase: 'recording', failure: null, createdAt: '2026-11-11T01:00:00.000Z' }] };

const state = vi.hoisted(() => ({
  owner: '', selectedBy: '', handle: 'h1', installed: true, enabled: true, granted: true, member: true,
  provisions: [] as Record<string, unknown>[], listeners: new Set<(extensionId: string) => void>(),
  asked: [] as Record<string, unknown>[], answer: null as null | ((request: Record<string, unknown>) => unknown),
  hooks: {} as { afterAsk?: () => void }, bindingCalls: 0, flipAfter: 0,
}));
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token || null }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [], boundConversationFiles: {} }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    conversationBinding: (owner: string, _app: string, name: string, action: string) => {
      if (!state.installed || !state.enabled || !state.granted || name !== 'main' || action !== 'voice-notes:record') throw denied('no grant');
      state.bindingCalls += 1;
      const handle = state.flipAfter && state.bindingCalls > state.flipAfter ? 'h-replaced' : state.handle;
      return owner === state.selectedBy ? { ownerId: owner, name, chatId: CHAT, handle } : null;
    },
    onBindingAuthorityChanged: (listener: (extensionId: string) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  }),
}));
vi.mock('./extension-bridge-relay', () => ({
  askVoiceNoteWindow: async (request: Record<string, unknown>) => {
    state.asked.push(request);
    const answer = state.answer ? state.answer(request) : { state: 'ready', view: IDLE };
    state.hooks.afterAsk?.();
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query, limit: () => query, eq: () => query,
        maybeSingle: async () => ({ data: state.member ? { chat_id: CHAT } : null, error: null }),
        abortSignal: async () => table === 'agent_provisions' ? { data: state.provisions, error: null } : { data: null, error: { message: 'unexpected' } },
      };
      return query;
    },
  }),
}));

const voice = await import('./app-voice-notes');
const watches = await import('./app-voice-note-watches');
const start = (extra: Record<string, unknown> = {}) => voice.appVoiceNoteStart('assistant', { name: 'main', ...extra });
const call = (verb: 'pause' | 'resume' | 'stop' | 'status') => voice.appVoiceNote(verb, 'assistant', { name: 'main' });
const told = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const startedAnswer = (request: Record<string, unknown>) => request.op === 'start'
  ? { state: 'ready', view: RECORDING, started: { outcome: 'started', job: JOB } } : { state: 'ready', view: RECORDING };

beforeEach(() => {
  Object.assign(state, { owner: OWNER, selectedBy: OWNER, handle: 'h1', installed: true, enabled: true, granted: true, member: true,
    provisions: [ASSISTANT], asked: [], answer: null, hooks: {}, bindingCalls: 0, flipAfter: 0 });
  for (const page of [1, 2, 3]) watches.stopVoiceWatches(page);
  if (watches.appVoiceRecording()) void watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view: { ...IDLE, jobs: RECORDING.jobs } });
});

describe('driving the recorder', () => {
  it('starts in the person\'s name for their personal assistant, with the meeting; the window is told the account and assistant, never by the App', async () => {
    state.answer = startedAnswer;
    const meeting = { title: 'Weekly sync', start: '2026-11-11T09:00:00Z', end: null };
    expect(await start({ meeting })).toEqual({ name: 'main', state: 'started', job: JOB });
    expect(state.asked).toEqual([{ op: 'start', ownerId: OWNER, assistantId: AGENT, meeting }]);
    expect(watches.appVoiceRecording()).toMatchObject({ extensionId: 'assistant', ownerId: OWNER, job: JOB });
    expect(await call('pause')).toMatchObject({ state: 'ready', recorder: { phase: 'recording' } });
    expect(state.asked.at(-1)).toEqual({ op: 'pause', ownerId: OWNER, assistantId: AGENT });
  });

  it('says why it did not start, from a closed set; a window that cannot answer is unavailable', async () => {
    for (const outcome of ['busy', 'no_assistant', 'cancelled', 'mic_denied', 'mic_missing', 'capture_failed'] as const) {
      state.answer = () => ({ state: 'ready', view: IDLE, started: { outcome } });
      expect(await start()).toEqual({ name: 'main', state: outcome });
    }
    // Anything else the window might say is not passed on.
    state.answer = () => ({ state: 'ready', view: IDLE, started: { outcome: 'started', job: '/Users/me/voice-notes/x' } });
    expect(await start()).toEqual({ name: 'main', state: 'unavailable' });
    state.answer = () => new Error('Renderer not ready');
    expect(await start()).toEqual({ name: 'main', state: 'unavailable' });
    expect(await call('status')).toEqual({ name: 'main', state: 'unavailable' });
    expect(watches.appVoiceRecording()).toBeNull();
  });

  it('refuses an owner, agent, chat or id the App names, and a malformed meeting, before anything is asked', async () => {
    for (const extra of [{ ownerId: OWNER }, { agentId: AGENT }, { chatId: CHAT }, { handle: 'h1' }, { path: '/tmp/a.webm' },
      { meeting: { title: '', start: '2026-11-11T09:00:00Z', end: null } }, { meeting: { title: 'x', start: 'tomorrow', end: null } },
      { meeting: { title: 'x', start: '2026-11-11T09:00:00Z', end: null, url: 'https://x' } }]) {
      await expect(start(extra)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(voice.appVoiceNoteRetry('assistant', { name: 'main', job: 'note-2026-11-11' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(voice.appVoiceNote('stop', 'assistant', { name: 'main', ownerId: OTHER })).rejects.toMatchObject({ code: 'invalid' });
    expect(state.asked).toEqual([]);
  });

  it('no conversation chosen: unbound, and the recorder is not asked', async () => {
    state.selectedBy = '';
    expect(await start()).toEqual({ name: 'main', state: 'unbound' });
    expect(await call('status')).toEqual({ name: 'main', state: 'unbound' });
    await expect(voice.appVoiceNoteOpenMicSettings('assistant', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    expect(state.asked).toEqual([]);
  });

  it('refuses without the grant, for another account, or when the conversation is not with the person\'s personal assistant', async () => {
    state.granted = false;
    await expect(start()).rejects.toMatchObject({ code: 'denied' });
    state.granted = true; state.enabled = false;
    await expect(call('stop')).rejects.toMatchObject({ code: 'denied' });
    state.enabled = true; state.installed = false;
    await expect(call('status')).rejects.toMatchObject({ code: 'denied' });
    state.installed = true;
    // Another account signed in: its own selection (none) is what counts.
    state.owner = OTHER;
    expect(await start()).toEqual({ name: 'main', state: 'unbound' });
    state.owner = OWNER;
    for (const provisions of [[{ ...ASSISTANT, member_key: 'researcher' }], [{ ...ASSISTANT, agent: { owner_user_id: OTHER, removed_at: null } }],
      [{ ...ASSISTANT, dm_chat_id: OTHER }], [],
      // The person's own conversation with another of their agents, the personal assistant's being elsewhere.
      [{ ...ASSISTANT, dm_chat_id: OTHER }, { ...ASSISTANT, agent_user_id: RESEARCHER, member_key: 'researcher', dm_chat_id: CHAT }]]) {
      state.provisions = provisions;
      await expect(start()).rejects.toMatchObject({ code: 'denied' });
      await expect(call('status')).rejects.toMatchObject({ code: 'denied' });
    }
    state.provisions = [ASSISTANT]; state.member = false;
    await expect(start()).rejects.toMatchObject({ code: 'denied' });
    expect(state.asked).toEqual([]);
  });

  it('the window refusing (another account there now) is a refusal; an unknown job is not found', async () => {
    state.answer = () => ({ state: 'denied' });
    await expect(call('stop')).rejects.toMatchObject({ code: 'denied' });
    state.answer = () => ({ state: 'unknown-job' });
    await expect(voice.appVoiceNoteRetry('assistant', { name: 'main', job: JOB })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a selection replaced or a grant withdrawn while starting: refused, and that recording stops at once', async () => {
    state.answer = startedAnswer;
    state.hooks.afterAsk = () => { state.handle = 'h2'; };
    await expect(start()).rejects.toMatchObject({ code: 'denied' });
    expect(state.asked.map((request) => request.op)).toEqual(['start', 'finish']);
    expect(state.asked.at(-1)).toEqual({ op: 'finish', job: JOB });
    expect(watches.appVoiceRecording()).toBeNull();
    // After any other call, the same: the answer is withheld.
    state.handle = 'h1'; state.hooks.afterAsk = () => { state.owner = OTHER; };
    await expect(call('status')).rejects.toMatchObject({ code: 'denied' });
  });
});

describe('what the App hears', () => {
  async function watch(watchId = '1', pageId = 1) {
    const heard: unknown[] = [];
    const answer = await voice.appVoiceNoteWatch('assistant', pageId, { watchId, name: 'main', on: true }, (id, event) => heard.push([id, event]));
    await told();
    return { heard, answer };
  }

  it('the recorder and its notes whole, at once and on every change, only these fields', async () => {
    state.answer = () => ({ state: 'ready', view: RECORDING });
    const { heard, answer } = await watch();
    expect(answer).toEqual({ name: 'main', state: 'watching' });
    expect(heard).toEqual([['1', { name: 'main', state: 'changed', ...RECORDING }]]);
    await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view: IDLE });
    expect(heard.at(-1)).toEqual(['1', { name: 'main', state: 'changed', ...IDLE }]);
  });

  it('an id, a path, a URL, the transcript or audio never passes: a view not exactly the allow-list is not heard, nor answered', async () => {
    const { heard } = await watch();
    heard.length = 0;
    const leaks: unknown[] = [
      { ...RECORDING, jobs: [{ ...RECORDING.jobs[0], id: '20261111-0100-ab12' }] },
      { ...RECORDING, jobs: [{ ...RECORDING.jobs[0], job: '20261111-0100-ab12' }] },
      { ...RECORDING, jobs: [{ ...RECORDING.jobs[0], failure: { stage: 'upload', retryable: true, reason: null, message: 'ENOENT /Users/me/x' } }] },
      { ...RECORDING, jobs: [{ ...RECORDING.jobs[0], failure: { stage: 'transcribe', retryable: true, reason: 'https://gateway.example/refused' } }] },
      { ...RECORDING, recorder: { ...RECORDING.recorder, cause: 'NotAllowedError' } },
      { ...RECORDING, transcript: 'hello' },
      { ...RECORDING, audio: 'UklGRg==' },
      { ...RECORDING, jobs: [{ ...RECORDING.jobs[0], title: 'Weekly sync' }] },
      { ...RECORDING, recorder: { ...RECORDING.recorder, level: 3 } },
    ];
    for (const view of leaks) {
      await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view });
      state.answer = () => ({ state: 'ready', view });
      expect(await call('status')).toEqual({ name: 'main', state: 'unavailable' });
    }
    expect(heard).toEqual([]);
  });

  it('the first view goes only to a watch still held when it comes: not after its unsubscribe, nor once its grant is gone', async () => {
    for (const lose of ['unwatch', 'grant'] as const) {
      state.granted = true;
      let release!: (answer: unknown) => void;
      state.answer = () => new Promise((resolve) => { release = resolve; });
      const heard: unknown[] = [];
      await voice.appVoiceNoteWatch('assistant', 1, { watchId: '7', name: 'main', on: true }, (id, event) => heard.push([id, event]));
      if (lose === 'unwatch') await voice.appVoiceNoteWatch('assistant', 1, { watchId: '7', name: 'main', on: false }, () => undefined);
      else state.granted = false;
      release({ state: 'ready', view: RECORDING });
      await told();
      expect(heard).toEqual([]);
      watches.stopVoiceWatches(1);
    }
  });

  it('a change the window tells after the grant went (before the service said so) ends the watch, unheard', async () => {
    const { heard } = await watch();
    heard.length = 0;
    state.granted = false;
    await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view: RECORDING });
    expect(heard).toEqual([['1', { name: 'main', state: 'ended' }]]);
  });

  it('heard only by watches of that account and assistant; another account signed in ends them', async () => {
    const { heard } = await watch();
    heard.length = 0;
    await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: OTHER, view: RECORDING });
    expect(heard).toEqual([]);
    state.owner = OTHER;
    await watches.voiceNoteChanged({ ownerId: OTHER, assistantId: AGENT, view: IDLE });
    expect(heard).toEqual([['1', { name: 'main', state: 'ended' }]]);
    expect(watches.heldVoiceWatches()).toBe(0);
  });

  it('ended when the grant, enablement or choice changes, or the App is uninstalled; a page closing drops its own', async () => {
    const first = await watch('1');
    state.granted = false;
    for (const listener of state.listeners) listener('assistant');
    await told();
    expect(first.heard.at(-1)).toEqual(['1', { name: 'main', state: 'ended' }]);
    state.granted = true;
    const second = await watch('2');
    state.handle = 'h9';
    for (const listener of state.listeners) listener('assistant');
    await told();
    expect(second.heard.at(-1)).toEqual(['2', { name: 'main', state: 'ended' }]);
    state.handle = 'h1';
    await watch('3', 2);
    watches.stopVoiceWatches(2);
    expect(watches.heldVoiceWatches()).toBe(0);
    // Nothing listens to the service when nothing holds anything.
    expect(state.listeners.size).toBe(0);
  });

  it('never started without a choice or the grant; a grant gone between the check and holding it is not held', async () => {
    state.selectedBy = '';
    expect((await watch('4')).answer).toEqual({ name: 'main', state: 'unbound' });
    state.selectedBy = OWNER; state.granted = false;
    await expect(watch('5')).rejects.toMatchObject({ code: 'denied' });
    state.granted = true;
    // Another conversation chosen right after the authority was found (its check and recheck), before the watch is held.
    state.bindingCalls = 0; state.flipAfter = 2;
    await expect(watch('6')).rejects.toMatchObject({ code: 'denied' });
    expect(watches.heldVoiceWatches()).toBe(0);
    expect(state.asked).toEqual([]);
  });
});

describe('a recording an App started', () => {
  async function recordingFromApp() {
    state.answer = startedAnswer;
    await start();
    state.asked.length = 0;
  }

  it('goes on when the App\'s page closes', async () => {
    await recordingFromApp();
    await voice.appVoiceNoteWatch('assistant', 3, { watchId: '1', name: 'main', on: true }, () => undefined);
    watches.stopVoiceWatches(3);
    await told();
    expect(state.asked.filter((request) => request.op === 'finish')).toEqual([]);
    expect(watches.appVoiceRecording()).not.toBeNull();
  });

  it('the App disabled, uninstalled or its grant withdrawn: that recording stops and its note is kept; the App is refused after', async () => {
    for (const lose of [() => { state.enabled = false; }, () => { state.installed = false; }, () => { state.granted = false; }, () => { state.handle = 'h7'; }]) {
      Object.assign(state, { enabled: true, installed: true, granted: true, handle: 'h1' });
      await recordingFromApp();
      lose();
      for (const listener of [...state.listeners]) listener('assistant');
      await told();
      expect(state.asked).toEqual([{ op: 'finish', job: JOB }] satisfies VoiceNoteWindowRequest[]);
      expect(watches.appVoiceRecording()).toBeNull();
      if (state.handle === 'h1') await expect(call('pause')).rejects.toMatchObject({ code: 'denied' });
    }
  });

  it('another App changing does not touch it; nor does a change that keeps its grant', async () => {
    await recordingFromApp();
    for (const listener of state.listeners) listener('other-app');
    for (const listener of state.listeners) listener('assistant');
    await told();
    expect(state.asked).toEqual([]);
    expect(watches.appVoiceRecording()).not.toBeNull();
  });

  it('over once the window shows its note with the recorder idle; another account in the window ends the hold', async () => {
    await recordingFromApp();
    // A view from before it started (no such note yet) does not end it.
    await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view: IDLE });
    expect(watches.appVoiceRecording()).not.toBeNull();
    await watches.voiceNoteChanged({ ownerId: OWNER, assistantId: AGENT, view: { ...IDLE, jobs: [{ ...RECORDING.jobs[0], phase: 'uploading' }] } });
    expect(watches.appVoiceRecording()).toBeNull();
    await recordingFromApp();
    await watches.voiceNoteChanged({ ownerId: OTHER, assistantId: AGENT, view: IDLE });
    expect(watches.appVoiceRecording()).toBeNull();
  });
});
