import { readAssistantPanelBridge } from '@/lib/assistantPanelBridge';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { i18n } from '@/i18n/runtime';
import { invokeOnMachine, rpc } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { VOICE_NOTE_MICROPHONE_CHANNEL } from '@shared/core/voice-notes';
import type { VoiceNoteWindowAnswer, VoiceNoteWindowRequest } from '@shared/extensions/voice-note-session';
import { appVoiceNotesActive } from './app-voice-notes-active';
import { createAppVoiceNoteCore, type AppVoiceNoteCore } from './app-voice-note-core';
import { retryVoiceNote, startVoiceNote, subscribeVoiceNotesContext, voiceJobs, voiceNotesAssistantId } from './voice-note-jobs';
import { voiceRecorder } from './voice-recorder';
import { startVoiceNoteAndSay } from './voice-recording-bar';

/**
 * #1927 (47) This window's answer to main's `extensions.voiceNote` (host-action-handlers.ts): the core
 * (app-voice-note-core.ts) on the real recorder, notes, account and shell. Made on the first App request — until an App
 * asks, nothing here runs — and from then on it tells main whenever the recorder or a note moves.
 */
let core: AppVoiceNoteCore | null = null;

function theCore(): AppVoiceNoteCore {
  if (core) return core;
  const shell = readAssistantShellBridge();
  core = createAppVoiceNoteCore({
    recorder: voiceRecorder,
    jobs: voiceJobs,
    // The App's call: the App says why it did not start. The host's own click: the host says it, as the composer's entry does.
    start: (meeting, present) => present ? startVoiceNoteAndSay(meeting, i18n.getFixedT(null, 'voiceNotes'), toast) : startVoiceNote(meeting),
    retry: retryVoiceNote,
    contextAssistant: voiceNotesAssistantId,
    subscribeContext: subscribeVoiceNotesContext,
    activate: appVoiceNotesActive.activate,
    account: () => readAssistantPanelBridge()?.accountId() ?? null,
    subscribeAccount: (listener) => readAssistantPanelBridge()?.subscribeAccount(listener) ?? (() => undefined),
    openMicSettings: () => invokeOnMachine(null, VOICE_NOTE_MICROPHONE_CHANNEL, 'open-settings'),
    shell: shell ? { get: () => shell.getVoiceNoteHandler(), set: (handler) => shell.setVoiceNoteHandler(handler) } : null,
    uuid: () => crypto.randomUUID(),
    now: () => performance.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  core.forward((change) => {
    void rpc.extensions.voiceNoteChanged(change).catch(() => undefined);
  });
  return core;
}

export function appVoiceNoteRequest(request: VoiceNoteWindowRequest): Promise<VoiceNoteWindowAnswer> {
  return theCore().handle(request);
}
