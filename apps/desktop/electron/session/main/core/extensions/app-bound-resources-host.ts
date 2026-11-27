import {
  EXTENSION_CONFIRM_RESOURCE_REMOVAL_METHOD, EXTENSION_EXPORT_VOICE_NOTE_METHOD, EXTENSION_TRANSCRIBE_VOICE_NOTE_METHOD,
  type ResourceRemovalAsk, type VoiceNoteExportAsk, type VoiceNoteExportOutcome, type VoiceNoteTranscribeAsk, type VoiceNoteTranscribeOutcome,
} from '@shared/extensions/host-actions';
import { invokeInEmbedder } from './extension-bridge-relay';

/**
 * #50 What the managing calls (app-bound-resources-manage.ts) need of the person's screen, each the host's own: the
 * question the assistant's page asks before a delete, this window's voice-note pipeline, and its save dialog.
 * Reached only in the person's click (the bridge checks it); the page never draws or answers any of them.
 */

export const manageHost = {
  /** The assistant page's own question before a delete, in the window that draws the page: true when the person said yes. */
  confirmRemoval(embedderId: number | null, ask: ResourceRemovalAsk): Promise<boolean> {
    return invokeInEmbedder(embedderId, EXTENSION_CONFIRM_RESOURCE_REMOVAL_METHOD, ask) as Promise<boolean>;
  },
  /** The page's 开始转写, in this window's voice-note pipeline. */
  transcribe(embedderId: number | null, ask: VoiceNoteTranscribeAsk): Promise<VoiceNoteTranscribeOutcome> {
    return invokeInEmbedder(embedderId, EXTENSION_TRANSCRIBE_VOICE_NOTE_METHOD, ask) as Promise<VoiceNoteTranscribeOutcome>;
  },
  /** The page's 导出 Markdown: its save dialog, its file name and its Markdown. */
  exportNote(embedderId: number | null, ask: VoiceNoteExportAsk): Promise<VoiceNoteExportOutcome> {
    return invokeInEmbedder(embedderId, EXTENSION_EXPORT_VOICE_NOTE_METHOD, ask) as Promise<VoiceNoteExportOutcome>;
  },
};
export type ManageHost = typeof manageHost;
