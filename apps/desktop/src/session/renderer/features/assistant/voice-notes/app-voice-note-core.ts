import {
  APP_VOICE_FAILURE_REASONS,
  type AppVoiceJob,
  type AppVoiceNoteView,
  type AppVoiceRecorder,
  type VoiceNoteWindowAnswer,
  type VoiceNoteWindowChange,
  type VoiceNoteWindowRequest,
} from '@shared/extensions/voice-note-session';
import type { VoiceJobView, StartOutcome } from './voice-note-jobs';
import type { RecorderSnapshot } from './voice-recorder';

/**
 * #1927 (47) The window's half of an App driving the voice-note recorder (`gugu.voiceNote`): the same recorder and the
 * same notes as the composer's 「录制语音笔记」 (voice-recorder.ts, voice-note-jobs.ts), asked by main once it has checked
 * the App's grant and found the assistant. Here: the account and assistant are checked again against this window's own
 * (never the page's word); what the App hears is projected to its allow-list (no id, path, URL, audio or transcript);
 * notes are named by handles that mean something only in this window; a recording the App started shows the rail's red
 * dot as a built-in one does, goes on when the App's page closes, and stops when the account changes.
 *
 * Built from its dependencies (app-voice-note-host.ts gives the real ones) so it can be tested without a microphone.
 */
export type AppVoiceNoteDeps = {
  recorder: {
    getSnapshot(): RecorderSnapshot;
    subscribe(listener: () => void): () => void;
    readonly busy: boolean;
    pause(): void;
    resume(): void;
    stop(): void;
    cancel(): void;
  };
  jobs: { getSnapshot(): readonly VoiceJobView[]; subscribe(listener: () => void): () => void };
  /** `present`: the host's own click — say why it did not start, as the composer's entry does (`startVoiceNoteAndSay`). */
  start(meeting: { title: string; start: string; end: string | null } | undefined, present: boolean): Promise<StartOutcome>;
  retry(id: string): Promise<void>;
  /** The assistant the recorder's notes go to, as this window's assistant pages set it; null before any did. */
  contextAssistant(): string | null;
  subscribeContext(listener: () => void): () => void;
  /** Ask this window to set that context from its own assistant-home data (app-voice-notes-context.tsx). */
  activate(): void;
  account(): string | null;
  subscribeAccount(listener: () => void): () => void;
  openMicSettings(): Promise<unknown>;
  /** The shell's registration the rail's red dot and the meeting reminder read (assistantShellBridge). */
  shell: { get(): ShellVoiceHandler | null; set(handler: ShellVoiceHandler | null): void } | null;
  uuid(): string;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};
export type ShellVoiceHandler = {
  start(meeting?: { title: string; start: string; end: string | null }): Promise<boolean>;
  busy(): boolean;
  subscribe(listener: () => void): () => void;
};

/** How long `start` waits for this window to know the assistant (the context component mounting and reading its home). */
export const CONTEXT_WAIT_MS = 3_000;
/** At most this often the App hears the recorder (its level meter ticks at the recorder's 100 ms anyway). */
export const FORWARD_INTERVAL_MS = 100;
const MAX_JOBS = 50;
const IDLE_RECORDER: AppVoiceRecorder = { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null };
const REASONS = new Set<string>(APP_VOICE_FAILURE_REASONS);
type FailureReason = (typeof APP_VOICE_FAILURE_REASONS)[number];

type Tag = { owner: string | null; assistant: string | null };

export function createAppVoiceNoteCore(deps: AppVoiceNoteDeps) {
  const handles = new Map<string, string>();
  const ids = new Map<string, string>();
  /** Whose each note is: the account and assistant when this window first saw it. Another's is never shown. */
  const jobTags = new Map<string, Tag>();
  /** Whose the recording is (from when it left idle), and the note an App started with it, while it lasts. */
  let recording: (Tag & { appJob: string | null }) | null = null;
  let shellHandler: ShellVoiceHandler | null = null;
  let lastPhase = deps.recorder.getSnapshot().phase;

  const tagNow = (): Tag => ({ owner: deps.account(), assistant: deps.contextAssistant() });
  const handleOf = (id: string) => {
    let handle = handles.get(id);
    if (!handle) {
      handle = deps.uuid();
      handles.set(id, handle);
      ids.set(handle, id);
    }
    return handle;
  };
  const tagJobs = () => {
    for (const job of deps.jobs.getSnapshot()) if (!jobTags.has(job.id)) jobTags.set(job.id, tagNow());
  };
  const mine = (tag: Tag | null | undefined, owner: string, assistant: string) => !!tag && tag.owner === owner && tag.assistant === assistant;

  function recorderView(owner: string, assistant: string): AppVoiceRecorder {
    // A recording (or its last error) of another account or assistant is not this one's to see.
    if (recording && !mine(recording, owner, assistant)) return IDLE_RECORDER;
    const snapshot = deps.recorder.getSnapshot();
    return {
      phase: snapshot.phase,
      elapsedMs: Math.max(0, Math.floor(snapshot.elapsedMs)),
      level: Math.round(Math.min(1, Math.max(0, snapshot.level)) * 100) / 100,
      silentMs: Math.max(0, Math.floor(snapshot.silentMs)),
      error: snapshot.error,
    };
  }

  function jobView(job: VoiceJobView): AppVoiceJob | null {
    const created = Date.parse(job.createdAt);
    if (!Number.isFinite(created)) return null;
    const failure = job.failure;
    return {
      job: handleOf(job.id),
      phase: job.phase,
      // The step and whether a retry may help; why, only as one of the reasons the App may word — never the error's text.
      failure: failure ? {
        stage: failure.stage,
        retryable: failure.retryable,
        reason: failure.notice ? 'refused' : failure.code && REASONS.has(failure.code) ? failure.code as FailureReason : null,
      } : null,
      createdAt: new Date(created).toISOString(),
    };
  }

  /** What the App of `owner`'s binding to `assistant` sees: the recorder, and their notes in this window. */
  function view(owner: string, assistant: string): AppVoiceNoteView {
    tagJobs();
    const jobs = deps.jobs.getSnapshot().filter((job) => mine(jobTags.get(job.id), owner, assistant))
      .slice(-MAX_JOBS).map(jobView).filter((job): job is AppVoiceJob => job !== null);
    return { recorder: recorderView(owner, assistant), jobs };
  }

  async function waitForContext(assistant: string): Promise<boolean> {
    if (deps.contextAssistant() === assistant) return true;
    deps.activate();
    return new Promise<boolean>((resolve) => {
      let timer: unknown = null;
      const stop = deps.subscribeContext(() => {
        if (deps.contextAssistant() !== assistant) return;
        stop(); deps.clearTimer(timer); resolve(true);
      });
      timer = deps.setTimer(() => { stop(); resolve(deps.contextAssistant() === assistant); }, CONTEXT_WAIT_MS);
    });
  }

  /** The rail's red dot reads the shell's registration: a recording an App started registers one, as the assistant page does. */
  function showOnRail() {
    if (!deps.shell || deps.shell.get()) return;
    shellHandler = {
      start: async (meeting) => (await deps.start(meeting, true)) === 'started',
      busy: () => deps.recorder.busy,
      subscribe: deps.recorder.subscribe,
    };
    deps.shell.set(shellHandler);
  }

  function onRecorder() {
    const phase = deps.recorder.getSnapshot().phase;
    if (lastPhase === 'idle' && phase !== 'idle') recording = { ...tagNow(), appJob: null };
    lastPhase = phase;
    if (phase === 'idle') {
      if (recording) recording.appJob = null;
      // Its registration goes when its recording does (the assistant page's stays while that page is up).
      if (shellHandler && deps.shell?.get() === shellHandler) deps.shell.set(null);
      shellHandler = null;
    }
  }

  function onAccount() {
    // Another account (or none): a recording an App started under the one before stops — fail closed. Its note fails to
    // upload as the account it was not recorded under.
    if (!recording?.appJob || recording.owner === deps.account() || !deps.recorder.busy) return;
    if (deps.recorder.getSnapshot().phase === 'starting') deps.recorder.cancel();
    else deps.recorder.stop();
  }

  const unsubscribe = [deps.recorder.subscribe(onRecorder), deps.jobs.subscribe(tagJobs), deps.subscribeAccount(onAccount)];

  async function handle(request: VoiceNoteWindowRequest): Promise<VoiceNoteWindowAnswer> {
    if (request.op === 'finish') {
      // Only the recording that App started, still going: one started since from the composer is not its to end.
      const id = ids.get(request.job);
      if (id && recording?.appJob === id && deps.recorder.busy) {
        if (deps.recorder.getSnapshot().phase === 'starting') deps.recorder.cancel();
        else deps.recorder.stop();
      }
      return { state: 'unavailable' };
    }
    const { ownerId, assistantId } = request;
    if (!ownerId || deps.account() !== ownerId) return { state: 'denied' };
    const ready = (): VoiceNoteWindowAnswer => deps.account() === ownerId ? { state: 'ready', view: view(ownerId, assistantId) } : { state: 'denied' };
    const ours = () => mine(recording, ownerId, assistantId);
    switch (request.op) {
      case 'status':
        return ready();
      case 'start': {
        if (!(await waitForContext(assistantId)) || deps.account() !== ownerId) {
          return deps.account() === ownerId ? { ...(ready() as { state: 'ready'; view: AppVoiceNoteView }), started: { outcome: 'no_assistant' } } : { state: 'denied' };
        }
        const before = new Set(deps.jobs.getSnapshot().map((job) => job.id));
        const outcome = await deps.start(request.meeting, request.present === true);
        if (outcome !== 'started') {
          const refused = outcome === 'interrupted' ? 'capture_failed' : outcome;
          return deps.account() === ownerId ? { state: 'ready', view: view(ownerId, assistantId), started: { outcome: refused } } : { state: 'denied' };
        }
        const id = deps.jobs.getSnapshot().map((job) => job.id).reverse().find((jobId) => !before.has(jobId));
        if (id) jobTags.set(id, { owner: ownerId, assistant: assistantId });
        if (recording) recording.appJob = id ?? null;
        if (deps.account() !== ownerId) {
          onAccount();
          return { state: 'denied' };
        }
        showOnRail();
        return { state: 'ready', view: view(ownerId, assistantId), started: { outcome: 'started', job: handleOf(id ?? '') } };
      }
      case 'pause':
        if (ours()) deps.recorder.pause();
        return ready();
      case 'resume':
        if (ours()) deps.recorder.resume();
        return ready();
      case 'stop':
        if (ours()) {
          if (deps.recorder.getSnapshot().phase === 'starting') deps.recorder.cancel();
          else deps.recorder.stop();
        }
        return ready();
      case 'retry': {
        const id = ids.get(request.job);
        if (!id || !mine(jobTags.get(id), ownerId, assistantId) || !deps.jobs.getSnapshot().some((job) => job.id === id)) return { state: 'unknown-job' };
        try {
          await deps.retry(id);
        } catch {
          return { state: 'unavailable' };
        }
        return ready();
      }
      case 'openMicSettings':
        await deps.openMicSettings();
        return ready();
    }
  }

  /**
   * Tell main whenever the recorder or a note moves, at most every `FORWARD_INTERVAL_MS` (the level meter's own tick), and
   * not at all when nothing an App sees changed. The last change always goes.
   */
  function forward(send: (change: VoiceNoteWindowChange) => void): () => void {
    let last = -Infinity;
    let timer: unknown = null;
    let sent = '';
    const flush = () => {
      timer = null;
      const owner = deps.account();
      const assistant = deps.contextAssistant();
      const change: VoiceNoteWindowChange = { ownerId: owner, assistantId: assistant,
        view: owner && assistant ? view(owner, assistant) : { recorder: IDLE_RECORDER, jobs: [] } };
      const said = JSON.stringify(change);
      if (said === sent) return;
      sent = said;
      last = deps.now();
      send(change);
    };
    const changed = () => {
      if (timer !== null) return;
      const wait = last + FORWARD_INTERVAL_MS - deps.now();
      if (wait <= 0) flush();
      else timer = deps.setTimer(flush, wait);
    };
    const stops = [deps.recorder.subscribe(changed), deps.jobs.subscribe(changed), deps.subscribeAccount(changed), deps.subscribeContext(changed)];
    return () => {
      for (const stop of stops) stop();
      if (timer !== null) deps.clearTimer(timer);
    };
  }

  return { handle, forward, view, dispose: () => { for (const stop of unsubscribe) stop(); } };
}
export type AppVoiceNoteCore = ReturnType<typeof createAppVoiceNoteCore>;
