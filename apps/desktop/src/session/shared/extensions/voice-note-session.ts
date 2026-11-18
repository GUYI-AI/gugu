import { z } from 'zod';

/**
 * #1927 (API 47) An App driving the person's voice-note recorder: the conversation binding's `voice-notes:record` action
 * (`chat:voice-notes:record`), when the bound conversation is the person's private one with their personal assistant.
 *
 * Everything that touches the microphone stays in the host: capture, 5-minute segments, upload to the assistant's home,
 * transcription and the hand-off to the assistant (voice-recorder.ts, voice-note-jobs.ts). The App starts, pauses,
 * resumes, stops and retries, and draws the bar from what it hears here — never audio, an id, a path, a URL or a word
 * of the transcript (those it reads, if granted, through the `voice-notes` resource domain, API 42). A recording keeps
 * going when the App's page closes, as one started from the composer does.
 */
export const VOICE_NOTE_RECORD_ACTION = 'voice-notes:record';
export const VOICE_NOTE_API_VERSION = 47;

export const APP_VOICE_RECORDER_PHASES = ['idle', 'starting', 'recording', 'paused', 'stopping'] as const;
export const APP_VOICE_RECORDER_ERRORS = ['mic_denied', 'mic_missing', 'capture_failed', 'interrupted'] as const;
export const APP_VOICE_JOB_PHASES = ['recording', 'uploading', 'transcribing', 'summarizing', 'ready', 'failed', 'no_speech'] as const;
/** Why a step failed, said as a reason the App may word itself: never the error's text, a path or a URL. */
export const APP_VOICE_FAILURE_REASONS = ['refused', 'signed-out', 'membership-required', 'model-unavailable', 'unreachable', 'service-unavailable'] as const;
/** What `start` answers besides `started` (voice-note-jobs.ts `StartOutcome`, closed). */
export const APP_VOICE_START_REFUSALS = ['busy', 'no_assistant', 'cancelled', 'mic_denied', 'mic_missing', 'capture_failed'] as const;

const instant = z.string().datetime({ offset: true });

/** The recorder as the bar draws it. `level` 0–1 (heard about ten times a second at most), times in milliseconds. */
export const appVoiceRecorderSchema = z.strictObject({
  phase: z.enum(APP_VOICE_RECORDER_PHASES),
  elapsedMs: z.number().int().min(0),
  level: z.number().min(0).max(1),
  silentMs: z.number().int().min(0),
  error: z.enum(APP_VOICE_RECORDER_ERRORS).nullable(),
});

/** One note on its way, named by an opaque handle that means something only to `retry` in this window. */
export const appVoiceJobSchema = z.strictObject({
  job: z.string().uuid(),
  phase: z.enum(APP_VOICE_JOB_PHASES),
  failure: z.strictObject({
    stage: z.enum(['upload', 'transcribe', 'summarize']),
    retryable: z.boolean(),
    reason: z.enum(APP_VOICE_FAILURE_REASONS).nullable(),
  }).nullable(),
  createdAt: instant,
});

/** Everything an App hears of the recorder and its notes: these fields, no others (main checks it before any page hears it). */
export const appVoiceNoteViewSchema = z.strictObject({
  recorder: appVoiceRecorderSchema,
  jobs: z.array(appVoiceJobSchema).max(50),
});

export type AppVoiceRecorder = z.infer<typeof appVoiceRecorderSchema>;
export type AppVoiceJob = z.infer<typeof appVoiceJobSchema>;
export type AppVoiceNoteView = z.infer<typeof appVoiceNoteViewSchema>;

/** `gugu.voiceNote.status(name)`; `unbound`: no conversation chosen; `unavailable`: the window cannot say now. */
export type AppVoiceNoteStatus = ({ name: string; state: 'ready' } & AppVoiceNoteView) | { name: string; state: 'unbound' | 'unavailable' };
/** `gugu.voiceNote.start(name, { meeting? })`. */
export type AppVoiceNoteStart = { name: string; state: 'started'; job: string }
  | { name: string; state: (typeof APP_VOICE_START_REFUSALS)[number] | 'unbound' | 'unavailable' };
/** `gugu.voiceNote.onChanged(name, fn)`: what changed, whole; or `ended` — the grant, account, App or choice changed. */
export type AppVoiceNoteEvent = ({ name: string; state: 'changed' } & AppVoiceNoteView) | { name: string; state: 'ended' };

/** A meeting the note is of (as the host's own meeting reminder passes it): written into the note, told to the assistant. */
export const voiceNoteMeetingSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  start: instant,
  end: instant.nullable(),
});

export const voiceNoteNameSchema = z.strictObject({ name: z.string() });
export const voiceNoteStartSchema = z.strictObject({ name: z.string(), meeting: voiceNoteMeetingSchema.optional() });
export const voiceNoteRetrySchema = z.strictObject({ name: z.string(), job: z.string().uuid() });
export const voiceNoteWatchSchema = z.strictObject({ watchId: z.string().min(1).max(64), name: z.string(), on: z.boolean() });

/** What main asks the window that holds the recorder (`extensions.voiceNote`); answered by app-voice-note-host.ts there. */
export type VoiceNoteWindowRequest =
  | { op: 'status' | 'pause' | 'resume' | 'stop' | 'openMicSettings'; ownerId: string; assistantId: string }
  | {
    op: 'start'; ownerId: string; assistantId: string; meeting?: z.infer<typeof voiceNoteMeetingSchema>;
    /** #1927 (48) The host's own click (a composer entry): the window says why it did not start, as the built-in entry does. */
    present?: true;
  }
  | { op: 'retry'; ownerId: string; assistantId: string; job: string }
  /** The App that started this recording lost its grant: stop it — that one, still recording — and keep the note. */
  | { op: 'finish'; job: string };
/** What the window tells main whenever the recorder or a note moves (at most about ten times a second). */
export type VoiceNoteWindowChange = { ownerId: string | null; assistantId: string | null; view: AppVoiceNoteView };
export type VoiceNoteWindowAnswer =
  | { state: 'ready'; view: AppVoiceNoteView; started?: { outcome: 'started'; job: string } | { outcome: (typeof APP_VOICE_START_REFUSALS)[number] } }
  | { state: 'unavailable' | 'denied' | 'unknown-job' };
