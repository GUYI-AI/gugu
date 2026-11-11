import '@/i18n/registerAssistantCatalog';
import '@/i18n/registerVoiceNotesCatalog';
import { i18n } from '@/i18n';
import { assistantPanelAccountId } from '@/lib/assistantPanelBridge';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { createResourceWindow, type ResourceWindow } from './app-resource-window-core';
import { retryVoiceNote, voiceJobs, voiceNotesContextAssistant } from './voice-note-jobs';

/** #48 The window's half of an App's managing calls (app-resource-window-core.ts), on this window's own pieces. */
let made: ResourceWindow | null = null;
export function resourceWindow(): ResourceWindow {
  made ??= createResourceWindow({
    account: assistantPanelAccountId,
    contextAssistant: voiceNotesContextAssistant,
    jobPhase: (noteId) => voiceJobs.get(noteId)?.phase ?? null,
    retry: retryVoiceNote,
    forget: (noteId) => voiceJobs.forget(noteId),
    confirm: (words) => new Promise<boolean>((resolve) => showModal('confirmActionModal', {
      ...words,
      variant: 'destructive',
      onSuccess: () => resolve(true),
      onClose: () => resolve(false),
    })),
    t: (key, ns, values) => String(i18n.t(key, { ns, ...values })),
    saveTextFile: (args) => rpc.app.saveTextFile(args),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return made;
}
