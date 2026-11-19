import { z } from 'zod';
import {
  APP_VOICE_START_REFUSALS,
  appVoiceNoteViewSchema,
  VOICE_NOTE_RECORD_ACTION,
  voiceNoteNameSchema,
  voiceNoteRetrySchema,
  voiceNoteStartSchema,
  voiceNoteWatchSchema,
  type AppVoiceNoteEvent,
  type AppVoiceNoteStart,
  type AppVoiceNoteStatus,
  type AppVoiceNoteView,
  type VoiceNoteWindowAnswer,
  type VoiceNoteWindowRequest,
} from '@shared/extensions/voice-note-session';
import { boundAgent, type Bound } from './app-bound-resources';
import { finish, forget, hearService, holdRecording, holds, watches, type AppRecording, type VoiceWatch } from './app-voice-note-watches';
import { askVoiceNoteWindow } from './extension-bridge-relay';

/**
 * #1927 (API 47) `gugu.voiceNote`: an App driving the host's voice-note recorder for the personal assistant its binding's
 * conversation is with. The authority is the resources' (app-bound-resources.ts `boundAgent`): the signed-in account's own
 * selection for this installed App, `voice-notes:record` granted, the conversation its private one with its personal
 * assistant — checked again after every wait. The recorder is the main window's (app-voice-note-host.ts there), which
 * checks its own account and assistant again; nothing the App says names either.
 *
 * Who hears it (`onChanged`) holds the authority it was granted under, ended as resource watches are. A recording an App
 * started goes on when its page closes; once that App loses its grant (disabled, uninstalled, withdrawn, another
 * conversation chosen) the host stops it and keeps the note — the audio is the person's — and the App's calls are refused.
 */

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

function argsOf<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid(`gugu.voiceNote takes the binding's name (and a meeting or a job handle), never an owner, agent, chat or id (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  return parsed.data;
}

async function bound(extensionId: string, name: string): Promise<Bound | 'unavailable' | null> {
  return boundAgent(extensionId, name, [VOICE_NOTE_RECORD_ACTION], null).catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
}

const startedSchema = z.union([
  z.strictObject({ outcome: z.literal('started'), job: z.string().uuid() }),
  z.strictObject({ outcome: z.enum(APP_VOICE_START_REFUSALS) }),
]);
type Started = z.infer<typeof startedSchema>;

/**
 * The window's answer; one it could not give is `unavailable`, its refusal a refusal. Never trusted past its allow-list:
 * a view that is not exactly the App's is no view (`null`) — though a recording it says it started is still held.
 */
async function ask(request: VoiceNoteWindowRequest): Promise<{ view: AppVoiceNoteView | null; started?: Started } | 'unavailable'> {
  let answer: VoiceNoteWindowAnswer;
  try {
    answer = await askVoiceNoteWindow(request);
  } catch {
    return 'unavailable';
  }
  if (answer.state === 'denied') throw denied('This account\'s recorder is not this App\'s to drive now');
  if (answer.state === 'unknown-job') throw Object.assign(new Error('No such voice note in this window'), { code: 'not-found' });
  if (answer.state !== 'ready') return 'unavailable';
  const view = appVoiceNoteViewSchema.safeParse(answer.view);
  const started = answer.started === undefined ? undefined : startedSchema.safeParse(answer.started);
  return { view: view.success ? view.data : null, ...(started?.success ? { started: started.data } : {}) };
}

const statusOf = (name: string, answer: Awaited<ReturnType<typeof ask>>): AppVoiceNoteStatus =>
  answer === 'unavailable' || !answer.view ? { name, state: 'unavailable' } : { name, state: 'ready', ...answer.view };

// ── The calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `gugu.voiceNote.start(name, { meeting? })` (in a click): `started` with the note's handle, or why not. `present` is the
 * host's own (#1927, 48: a composer entry the person clicked): the window then says why it did not start, as the built-in does.
 */
export async function appVoiceNoteStart(extensionId: string, input: unknown, options: { present?: true } = {}): Promise<AppVoiceNoteStart> {
  const { name, meeting } = argsOf(voiceNoteStartSchema, input);
  const grant = await bound(extensionId, name);
  if (grant === null) return { name, state: 'unbound' };
  if (grant === 'unavailable') return { name, state: 'unavailable' };
  const answer = await ask({ op: 'start', ownerId: grant.ownerId, assistantId: grant.agentId, ...(meeting ? { meeting } : {}), ...(options.present ? { present: true as const } : {}) });
  const started = answer === 'unavailable' ? undefined : answer.started;
  if (started?.outcome === 'started') {
    const mine: AppRecording = { extensionId, name, ownerId: grant.ownerId, handle: grant.handle, job: started.job };
    // Its grant went while it was starting: it stops at once, and keeps what it has.
    try {
      await grant.recheck();
    } catch (error) {
      finish(mine);
      throw error;
    }
    holdRecording(mine);
    return { name, state: 'started', job: started.job };
  }
  await grant.recheck();
  return { name, state: started?.outcome ?? 'unavailable' };
}

type Verb = 'pause' | 'resume' | 'stop' | 'status';

/** `pause` / `resume` (in a click) / `stop` / `status`: the recorder and the notes as the App may see them, after it. */
export async function appVoiceNote(verb: Verb, extensionId: string, input: unknown): Promise<AppVoiceNoteStatus> {
  const { name } = argsOf(voiceNoteNameSchema, input);
  const grant = await bound(extensionId, name);
  if (grant === null) return { name, state: 'unbound' };
  if (grant === 'unavailable') return { name, state: 'unavailable' };
  const answer = await ask({ op: verb, ownerId: grant.ownerId, assistantId: grant.agentId });
  await grant.recheck();
  return statusOf(name, answer);
}

/** `gugu.voiceNote.retry(name, job)` (in a click): that note picks up where it stopped. */
export async function appVoiceNoteRetry(extensionId: string, input: unknown): Promise<AppVoiceNoteStatus> {
  const { name, job } = argsOf(voiceNoteRetrySchema, input);
  const grant = await bound(extensionId, name);
  if (grant === null) return { name, state: 'unbound' };
  if (grant === 'unavailable') return { name, state: 'unavailable' };
  const answer = await ask({ op: 'retry', ownerId: grant.ownerId, assistantId: grant.agentId, job });
  await grant.recheck();
  return statusOf(name, answer);
}

/** `gugu.voiceNote.openMicSettings(name)` (in a click): the system's microphone settings, as the composer's 「打开系统设置」. */
export async function appVoiceNoteOpenMicSettings(extensionId: string, input: unknown): Promise<void> {
  const { name } = argsOf(voiceNoteNameSchema, input);
  const grant = await bound(extensionId, name);
  if (grant === null) throw denied('No conversation is chosen for this binding');
  if (grant === 'unavailable') throw Object.assign(new Error('The recorder cannot be reached now'), { code: 'unavailable' });
  const answer = await ask({ op: 'openMicSettings', ownerId: grant.ownerId, assistantId: grant.agentId });
  await grant.recheck();
  if (answer === 'unavailable' || !answer.view) throw Object.assign(new Error('The recorder cannot be reached now'), { code: 'unavailable' });
}

/**
 * `gugu.voiceNote.onChanged(name, fn)` (watch / unwatch): held from now on if its grant still holds, and told the recorder
 * as it is now at once. `unbound`: nothing is watched.
 */
export async function appVoiceNoteWatch(
  extensionId: string, pageId: number, input: unknown, hear: (watchId: string, event: AppVoiceNoteEvent) => void,
): Promise<{ name: string; state: 'watching' | 'unbound' | 'unavailable' | 'stopped' }> {
  const { watchId, name, on } = argsOf(voiceNoteWatchSchema, input);
  if (!on) {
    const watch = watches.get(pageId)?.get(watchId);
    if (watch) forget(watch);
    return { name, state: 'stopped' };
  }
  const grant = await bound(extensionId, name);
  if (grant === null) return { name, state: 'unbound' };
  if (grant === 'unavailable') return { name, state: 'unavailable' };
  const watch: VoiceWatch = { pageId, watchId, extensionId, name, ownerId: grant.ownerId, handle: grant.handle, assistantId: grant.agentId,
    hear: (event) => hear(watchId, event) };
  const previous = watches.get(pageId)?.get(watchId);
  if (previous) forget(previous);
  let page = watches.get(pageId);
  if (!page) watches.set(pageId, page = new Map());
  page.set(watchId, watch);
  hearService();
  // Checked after it is listening, so a change between the last check and here is not missed.
  if (!holds(watch)) {
    forget(watch);
    throw denied('Conversation binding changed');
  }
  // What it is now (and the window telling main from here on).
  void ask({ op: 'status', ownerId: grant.ownerId, assistantId: grant.agentId }).then((answer) => {
    if (answer !== 'unavailable' && answer.view && watches.get(pageId)?.get(watchId) === watch && holds(watch)) watch.hear({ name, state: 'changed', ...answer.view });
  }, () => undefined);
  return { name, state: 'watching' };
}
