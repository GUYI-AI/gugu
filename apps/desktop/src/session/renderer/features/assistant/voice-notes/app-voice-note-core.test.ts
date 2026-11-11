import { describe, expect, it } from 'vitest';
import { appVoiceNoteViewSchema, type VoiceNoteWindowChange } from '@shared/extensions/voice-note-session';
import { CONTEXT_WAIT_MS, createAppVoiceNoteCore, type AppVoiceNoteDeps, type ShellVoiceHandler } from './app-voice-note-core';
import type { StartOutcome, VoiceJobView } from './voice-note-jobs';
import type { RecorderSnapshot } from './voice-recorder';

/**
 * #1927 (47) The window's half of an App driving the voice-note recorder: the same recorder and notes as the composer's,
 * here as fakes (no microphone). What the App sees is the allow-list; notes are opaque handles; a recording an App started
 * shows on the rail as a built-in one does and stops when the account changes; the level is heard at most ten times a second.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const AGENT = '44000000-0000-4000-8000-000000000004';
const IDLE: RecorderSnapshot = { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null };

function fakes() {
  const listeners = { recorder: new Set<() => void>(), jobs: new Set<() => void>(), account: new Set<() => void>(), context: new Set<() => void>() };
  const fire = (which: keyof typeof listeners) => { for (const listener of [...listeners[which]]) listener(); };
  const sub = (which: keyof typeof listeners) => (listener: () => void) => { listeners[which].add(listener); return () => listeners[which].delete(listener); };
  let clock = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const world = {
    snapshot: IDLE as RecorderSnapshot,
    jobs: [] as VoiceJobView[],
    account: OWNER as string | null,
    context: AGENT as string | null,
    activated: 0,
    calls: [] as string[],
    outcome: 'started' as StartOutcome,
    shellHandler: null as ShellVoiceHandler | null,
    sent: [] as VoiceNoteWindowChange[],
    presented: [] as boolean[],
  };
  const setRecorder = (patch: Partial<RecorderSnapshot>) => { world.snapshot = { ...world.snapshot, ...patch }; fire('recorder'); };
  let n = 0;
  const deps: AppVoiceNoteDeps = {
    recorder: {
      getSnapshot: () => world.snapshot,
      subscribe: sub('recorder'),
      get busy() { return world.snapshot.phase !== 'idle'; },
      pause: () => { world.calls.push('pause'); setRecorder({ phase: 'paused' }); },
      resume: () => { world.calls.push('resume'); setRecorder({ phase: 'recording' }); },
      stop: () => { world.calls.push('stop'); setRecorder({ phase: 'idle' }); },
      cancel: () => { world.calls.push('cancel'); setRecorder({ phase: 'idle' }); },
    },
    jobs: { getSnapshot: () => world.jobs, subscribe: sub('jobs') },
    start: async (meeting, present) => {
      world.calls.push(`start${meeting ? `:${meeting.title}` : ''}`);
      world.presented.push(present);
      if (world.outcome !== 'started') return world.outcome;
      setRecorder({ phase: 'starting' });
      setRecorder({ phase: 'recording' });
      world.jobs = [...world.jobs, job(`2026111${world.jobs.length}-0100-ab12`)];
      fire('jobs');
      return 'started';
    },
    retry: async (id) => { world.calls.push(`retry:${id}`); },
    contextAssistant: () => world.context,
    subscribeContext: sub('context'),
    activate: () => { world.activated += 1; },
    account: () => world.account,
    subscribeAccount: sub('account'),
    openMicSettings: async () => { world.calls.push('mic-settings'); },
    shell: { get: () => world.shellHandler, set: (handler) => { world.shellHandler = handler; } },
    uuid: () => `99000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => clock,
    setTimer: (run, ms) => { const id = ++ids; timers.push({ at: clock + ms, run, id }); return id; },
    clearTimer: (id) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); },
  };
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock = next.at;
      next.run();
    }
    clock = until;
  };
  return { world, deps, fire, setRecorder, advance, core: createAppVoiceNoteCore(deps) };
}

function job(id: string, patch: Partial<VoiceJobView> = {}): VoiceJobView {
  return { id, phase: 'recording', failure: null, title: null, dismissed: false, createdAt: '2026-11-11T01:00:00.000Z', ...patch };
}
const ask = { ownerId: OWNER, assistantId: AGENT };

describe('what an App sees', () => {
  it('only the allow-list: no note id, path, URL, error text, gateway words or title — and handles that stay the same', async () => {
    const { world, fire, core } = fakes();
    world.snapshot = { phase: 'recording', elapsedMs: 1234.7, level: 0.4567, silentMs: 15.2, error: null, cause: new Error('/dev/audio busy') };
    world.jobs = [
      job('20261111-0100-ab12', { phase: 'failed', title: 'Weekly sync', failure: { stage: 'upload', message: 'ENOENT /Users/me/assistant/memory/voice-notes/20261111-0100-ab12/audio/000.webm', retryable: true } }),
      job('20261111-0200-cd34', { phase: 'failed', failure: { stage: 'transcribe', message: 'refused', retryable: true, notice: 'See https://gateway.example/pricing', code: null } }),
      job('20261111-0300-ef56', { phase: 'failed', failure: { stage: 'transcribe', message: 'x', retryable: false, code: 'membership-required' } }),
      job('20261111-0400-0000', { phase: 'ready', createdAt: 'not a time' }),
    ];
    fire('jobs');
    const answer = await core.handle({ op: 'status', ...ask });
    expect(answer.state).toBe('ready');
    const view = (answer as { view: unknown }).view;
    expect(appVoiceNoteViewSchema.safeParse(view).success).toBe(true);
    const said = JSON.stringify(view);
    for (const leak of ['20261111', '/Users', 'ENOENT', 'https://', 'gateway', 'Weekly sync', '/dev/audio', 'webm']) expect(said).not.toContain(leak);
    expect(view).toEqual({
      recorder: { phase: 'recording', elapsedMs: 1234, level: 0.46, silentMs: 15, error: null },
      jobs: [
        { job: expect.stringMatching(/^99000000-/), phase: 'failed', failure: { stage: 'upload', retryable: true, reason: null }, createdAt: '2026-11-11T01:00:00.000Z' },
        { job: expect.any(String), phase: 'failed', failure: { stage: 'transcribe', retryable: true, reason: 'refused' }, createdAt: '2026-11-11T01:00:00.000Z' },
        { job: expect.any(String), phase: 'failed', failure: { stage: 'transcribe', retryable: false, reason: 'membership-required' }, createdAt: '2026-11-11T01:00:00.000Z' },
      ],
    });
    const again = (await core.handle({ op: 'status', ...ask })) as { view: { jobs: { job: string }[] } };
    expect(again.view.jobs.map((entry) => entry.job)).toEqual((view as { jobs: { job: string }[] }).jobs.map((entry) => entry.job));
  });

  it('a handle retries its own note; an unknown handle, or another account\'s note, is not found', async () => {
    const { world, fire, core } = fakes();
    world.jobs = [job('20261111-0100-ab12', { phase: 'failed', failure: { stage: 'upload', message: 'x', retryable: true } })];
    fire('jobs');
    const [{ job: handle }] = ((await core.handle({ op: 'status', ...ask })) as { view: { jobs: { job: string }[] } }).view.jobs;
    expect((await core.handle({ op: 'retry', ...ask, job: handle })).state).toBe('ready');
    expect(world.calls).toEqual(['retry:20261111-0100-ab12']);
    expect(await core.handle({ op: 'retry', ...ask, job: '99000000-0000-4000-8000-000000000999' })).toEqual({ state: 'unknown-job' });
    // The same note, asked for by another account signed in here now: not theirs.
    world.account = OTHER;
    expect(await core.handle({ op: 'retry', ownerId: OTHER, assistantId: AGENT, job: handle })).toEqual({ state: 'unknown-job' });
    expect(world.calls).toEqual(['retry:20261111-0100-ab12']);
  });

  it('refuses an account that is not this window\'s; never shows another account\'s notes or recording', async () => {
    const { world, fire, setRecorder, core } = fakes();
    expect(await core.handle({ op: 'status', ownerId: OTHER, assistantId: AGENT })).toEqual({ state: 'denied' });
    world.account = null;
    expect(await core.handle({ op: 'start', ...ask })).toEqual({ state: 'denied' });
    // Notes and a recording seen under one account…
    world.account = OWNER;
    setRecorder({ phase: 'recording' });
    world.jobs = [job('20261111-0100-ab12')];
    fire('jobs');
    // …are nobody else's.
    world.account = OTHER;
    fire('account');
    const theirs = (await core.handle({ op: 'status', ownerId: OTHER, assistantId: AGENT })) as { view: unknown };
    expect(theirs.view).toEqual({ recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null }, jobs: [] });
    await core.handle({ op: 'stop', ownerId: OTHER, assistantId: AGENT });
    expect(world.calls).toEqual([]);
  });

  it('another account than this window\'s is refused before anything is done: no settings opened, no note retried', async () => {
    const { world, fire, core } = fakes();
    world.jobs = [job('20261111-0100-ab12', { phase: 'failed', failure: { stage: 'upload', message: 'x', retryable: true } })];
    fire('jobs');
    const [{ job: handle }] = ((await core.handle({ op: 'status', ...ask })) as { view: { jobs: { job: string }[] } }).view.jobs;
    expect(await core.handle({ op: 'openMicSettings', ownerId: OTHER, assistantId: AGENT })).toEqual({ state: 'denied' });
    expect(await core.handle({ op: 'retry', ownerId: OTHER, assistantId: AGENT, job: handle })).toEqual({ state: 'denied' });
    expect(world.calls).toEqual([]);
  });

  it('the newest fifty notes at most', async () => {
    const { world, fire, core } = fakes();
    world.jobs = Array.from({ length: 60 }, (_, at) => job(`20261111-${String(at).padStart(4, '0')}-ab12`));
    fire('jobs');
    const view = ((await core.handle({ op: 'status', ...ask })) as { view: unknown }).view;
    expect(appVoiceNoteViewSchema.safeParse(view).success).toBe(true);
    expect((view as { jobs: unknown[] }).jobs).toHaveLength(50);
  });
});

describe('driving it', () => {
  it('starts with the meeting; the answer is the new note\'s handle; pause, resume, stop act on that recording', async () => {
    const { world, core } = fakes();
    const started = await core.handle({ op: 'start', ...ask, meeting: { title: 'Sync', start: '2026-11-11T09:00:00Z', end: null } });
    expect(started).toMatchObject({ state: 'ready', started: { outcome: 'started', job: expect.stringMatching(/^99000000-/) } });
    const view = (started as { view: { jobs: { job: string }[] } }).view;
    expect(view.jobs.map((entry) => entry.job)).toEqual([(started as { started: { job: string } }).started.job]);
    await core.handle({ op: 'pause', ...ask });
    await core.handle({ op: 'resume', ...ask });
    await core.handle({ op: 'stop', ...ask });
    expect(world.calls).toEqual(['start:Sync', 'pause', 'resume', 'stop']);
  });

  it('says why it did not start only for the host\'s own click (a composer entry, the rail\'s handler) — an App\'s call leaves that to the App', async () => {
    const { world, core } = fakes();
    world.outcome = 'busy';
    await core.handle({ op: 'start', ...ask });
    await core.handle({ op: 'start', ...ask, present: true });
    expect(world.presented).toEqual([false, true]);
    world.outcome = 'started';
    await core.handle({ op: 'start', ...ask });
    await core.handle({ op: 'stop', ...ask });
    // The handler the rail and the meeting reminder call is the host's own, as the assistant page's is.
    world.shellHandler = null;
    await core.handle({ op: 'start', ...ask });
    const rail = world.shellHandler as ShellVoiceHandler | null;
    await core.handle({ op: 'stop', ...ask });
    await rail?.start();
    expect(world.presented.slice(2)).toEqual([false, false, true]);
  });

  it('every way it does not start, from a closed set (a recording cut short at once is a capture failure)', async () => {
    for (const outcome of ['busy', 'no_assistant', 'cancelled', 'mic_denied', 'mic_missing', 'capture_failed', 'interrupted'] as const) {
      const { world, core } = fakes();
      world.outcome = outcome;
      expect(await core.handle({ op: 'start', ...ask })).toMatchObject({ state: 'ready', started: { outcome: outcome === 'interrupted' ? 'capture_failed' : outcome } });
    }
  });

  it('waits for this window to know the assistant (from its own data), else says there is none — never takes the App\'s word', async () => {
    const { world, fire, advance, core } = fakes();
    world.context = null;
    const pending = core.handle({ op: 'start', ...ask });
    await Promise.resolve();
    expect(world.activated).toBe(1);
    world.context = AGENT;
    fire('context');
    expect(await pending).toMatchObject({ started: { outcome: 'started' } });
    // Another assistant set here: no recording for the one the App's binding found.
    const other = fakes();
    other.world.context = OTHER;
    const waiting = other.core.handle({ op: 'start', ...ask });
    await Promise.resolve();
    other.advance(CONTEXT_WAIT_MS);
    expect(await waiting).toMatchObject({ started: { outcome: 'no_assistant' } });
    expect(other.world.calls).toEqual([]);
    // Nor when this window comes to know another assistant while it waits.
    const late = fakes();
    late.world.context = null;
    const later = late.core.handle({ op: 'start', ...ask });
    await Promise.resolve();
    late.world.context = OTHER;
    late.fire('context');
    late.advance(CONTEXT_WAIT_MS);
    expect(await later).toMatchObject({ started: { outcome: 'no_assistant' } });
    expect(late.world.calls).toEqual([]);
    void advance;
  });

  it('pause, resume and stop leave alone a recording for another assistant', async () => {
    const { world, setRecorder, core } = fakes();
    world.context = OTHER;
    setRecorder({ phase: 'starting' });
    setRecorder({ phase: 'recording' });
    world.context = AGENT;
    for (const op of ['pause', 'resume', 'stop'] as const) await core.handle({ op, ...ask });
    expect(world.calls).toEqual([]);
  });

  it('opens the system\'s microphone settings', async () => {
    const { world, core } = fakes();
    await core.handle({ op: 'openMicSettings', ...ask });
    expect(world.calls).toEqual(['mic-settings']);
  });
});

describe('the host\'s own indicators and its lifetime', () => {
  it('a recording the App started shows on the rail (as the assistant page\'s does) and leaves it when it ends', async () => {
    const { world, core } = fakes();
    await core.handle({ op: 'start', ...ask });
    expect(world.shellHandler?.busy()).toBe(true);
    await core.handle({ op: 'stop', ...ask });
    expect(world.shellHandler).toBeNull();
    // The assistant page's own registration is left alone.
    const page: ShellVoiceHandler = { start: async () => true, busy: () => false, subscribe: () => () => undefined };
    world.shellHandler = page;
    await core.handle({ op: 'start', ...ask });
    await core.handle({ op: 'stop', ...ask });
    expect(world.shellHandler).toBe(page);
  });

  it('another account signed in: the recording the App started stops; one started from the composer does not', async () => {
    const { world, fire, setRecorder, core } = fakes();
    await core.handle({ op: 'start', ...ask });
    world.account = OTHER;
    fire('account');
    expect(world.calls).toEqual(['start', 'stop']);
    // From the composer (not the App).
    const composer = fakes();
    composer.setRecorder({ phase: 'starting' });
    composer.setRecorder({ phase: 'recording' });
    composer.world.account = OTHER;
    composer.fire('account');
    expect(composer.world.calls).toEqual([]);
    void setRecorder; void core;
  });

  it('another account signed in while it was starting: refused, stopped at once, not shown on the rail', async () => {
    const { world, deps, fire, core } = fakes();
    const real = deps.start;
    deps.start = async (meeting, present) => {
      const outcome = await real(meeting, present);
      world.account = OTHER;
      fire('account');
      return outcome;
    };
    expect(await core.handle({ op: 'start', ...ask })).toEqual({ state: 'denied' });
    expect(world.calls).toEqual(['start', 'stop']);
    expect(world.shellHandler).toBeNull();
  });

  it('`finish` (that App lost its grant) stops that recording only — not one started since from the composer', async () => {
    const { world, setRecorder, core } = fakes();
    const started = await core.handle({ op: 'start', ...ask }) as { started: { job: string } };
    await core.handle({ op: 'finish', job: started.started.job });
    expect(world.calls).toEqual(['start', 'stop']);
    setRecorder({ phase: 'starting' });
    setRecorder({ phase: 'recording' });
    await core.handle({ op: 'finish', job: started.started.job });
    expect(world.calls).toEqual(['start', 'stop']);
  });
});

describe('telling main', () => {
  it('at most ten times a second however fast the meter moves; the last state always goes; nothing unchanged is told', () => {
    const { world, setRecorder, advance, core } = fakes();
    core.forward((change) => world.sent.push(change));
    setRecorder({ phase: 'recording' });
    for (let tick = 1; tick <= 100; tick += 1) {
      advance(10);
      setRecorder({ level: (tick % 10) / 10, elapsedMs: tick * 10 });
    }
    advance(200);
    expect(world.sent.length).toBeGreaterThan(5);
    expect(world.sent.length).toBeLessThanOrEqual(12);
    expect(world.sent.at(-1)).toMatchObject({ ownerId: OWNER, assistantId: AGENT, view: { recorder: { elapsedMs: 1000, level: 0 } } });
    const before = world.sent.length;
    setRecorder({});
    advance(500);
    expect(world.sent.length).toBe(before);
    for (const change of world.sent) expect(appVoiceNoteViewSchema.safeParse(change.view).success).toBe(true);
    // A change just after one was told, then quiet: it still goes, once the interval is up.
    setRecorder({ level: 0.9 });
    advance(30);
    setRecorder({ level: 0.33 });
    expect(world.sent.at(-1)).toMatchObject({ view: { recorder: { level: 0.9 } } });
    advance(100);
    expect(world.sent.at(-1)).toMatchObject({ view: { recorder: { level: 0.33 } } });
  });
});
