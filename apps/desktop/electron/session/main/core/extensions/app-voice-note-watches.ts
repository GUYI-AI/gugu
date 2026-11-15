import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { z } from 'zod';
import {
  appVoiceNoteViewSchema,
  VOICE_NOTE_RECORD_ACTION,
  type AppVoiceNoteEvent,
  type VoiceNoteWindowChange,
} from '@shared/extensions/voice-note-session';
import { currentAccountAccessToken } from './account-token';
import { askVoiceNoteWindow } from './extension-bridge-relay';
import { extensionsService } from './extensions-root';

/**
 * #1927 (47) What outlives one `gugu.voiceNote` call: the recording an App started (stopped, its note kept, once that App
 * loses its grant), and who hears the recorder (`onChanged`), each holding the authority it was granted under — ended,
 * as resource watches are, when the grant, enablement, install, choice or account changes. Torn down with its page
 * (`stopPageWatches`); the recording is not. Nothing here asks the store: the calls are app-voice-notes.ts.
 */
// ── A recording an App started ────────────────────────────────────────────────────────────────────────────────────────

export type AppRecording = { extensionId: string; name: string; ownerId: string; handle: string; job: string };
let recording: AppRecording | null = null;

/** Held from now on (the call that started it checked its grant again first). */
export function holdRecording(next: AppRecording): void {
  recording = next;
  hearService();
}

export function holds(grant: { ownerId: string; extensionId: string; name: string; handle: string }): boolean {
  try {
    return extensionsService().conversationBinding(grant.ownerId, grant.extensionId, grant.name, VOICE_NOTE_RECORD_ACTION)?.handle === grant.handle;
  } catch {
    return false;
  }
}

/** That App lost its grant: the window stops that recording (only that one, if it still goes) and keeps the note. */
export function finish(which: AppRecording): void {
  if (recording === which) recording = null;
  void askVoiceNoteWindow({ op: 'finish', job: which.job }).catch(() => undefined);
}

// ── Who hears it ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type VoiceWatch = { pageId: number; watchId: string; extensionId: string; name: string; ownerId: string; handle: string; assistantId: string; hear(event: AppVoiceNoteEvent): void };
export const watches = new Map<number, Map<string, VoiceWatch>>();
let stopHearingService: (() => void) | null = null;

const allWatches = () => [...watches.values()].flatMap((page) => [...page.values()]);

export function hearService(): void {
  stopHearingService ??= extensionsService().onBindingAuthorityChanged((extensionId) => {
    if (recording?.extensionId === extensionId && !holds(recording)) finish(recording);
    void revalidateVoiceWatches((watch) => watch.extensionId === extensionId);
  });
}

function settleService(): void {
  if (watches.size === 0 && !recording) {
    stopHearingService?.();
    stopHearingService = null;
  }
}

export function forget(watch: VoiceWatch): boolean {
  const page = watches.get(watch.pageId);
  if (page?.get(watch.watchId) !== watch) return false;
  page.delete(watch.watchId);
  if (page.size === 0) watches.delete(watch.pageId);
  settleService();
  return true;
}

function end(watch: VoiceWatch): void {
  if (forget(watch)) watch.hear({ name: watch.name, state: 'ended' });
}

async function signedIn(): Promise<string | null> {
  const token = await currentAccountAccessToken().catch(() => null);
  return token ? userIdFromSupabaseAccessToken(token) : null;
}

export async function revalidateVoiceWatches(which: (watch: VoiceWatch) => boolean = () => true): Promise<void> {
  const owner = await signedIn();
  for (const watch of allWatches()) if (which(watch) && (owner !== watch.ownerId || !holds(watch))) end(watch);
}

/**
 * The window says the recorder or a note moved (controller `voiceNoteChanged`, at most about ten times a second). Each
 * watch still holding its grant, of that account and assistant, hears it whole — as checked against the allow-list —
 * and a watch of an account no longer signed in ends.
 */
export async function voiceNoteChanged(input: unknown): Promise<void> {
  const change = z.strictObject({ ownerId: z.string().nullable(), assistantId: z.string().nullable(), view: appVoiceNoteViewSchema }).safeParse(input);
  if (!change.success) return;
  const { ownerId, assistantId, view } = change.data as VoiceNoteWindowChange;
  // That recording is over once a view showing its note shows the recorder idle (one from before it started has no such note).
  const over = recording && view.recorder.phase === 'idle' && view.jobs.some((job) => job.job === recording?.job);
  if (recording && (recording.ownerId !== ownerId || over)) {
    recording = null;
    settleService();
  }
  const owner = await signedIn();
  for (const watch of allWatches()) {
    if (owner !== watch.ownerId || ownerId !== watch.ownerId || !holds(watch)) end(watch);
    else if (assistantId === watch.assistantId) watch.hear({ name: watch.name, state: 'changed', ...view });
  }
}

export function stopVoiceWatches(pageId: number): void {
  for (const watch of [...watches.get(pageId)?.values() ?? []]) forget(watch);
}

/** Test seams. */
export const heldVoiceWatches = (): number => allWatches().length;
export const appVoiceRecording = (): Readonly<AppRecording> | null => recording;
