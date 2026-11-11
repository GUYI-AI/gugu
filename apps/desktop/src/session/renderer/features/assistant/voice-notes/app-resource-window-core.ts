import { exportFileName, exportMarkdown, parseTranscript } from '@gugu/core/shared/voiceNotes';
import type {
  ResourceRemovalAsk, VoiceNoteExportAsk, VoiceNoteExportOutcome, VoiceNoteTranscribeAsk, VoiceNoteTranscribeOutcome,
} from '@shared/extensions/host-actions';

/**
 * #48 This window's half of an App's managing calls (app-bound-resources-manage.ts in main): the assistant page's own
 * question before a delete, its 开始转写 and its 导出 Markdown — the same words, the same pipeline, the same save dialog.
 * The window checks the account (and, for a voice note, the assistant) it has itself; main checked the App's authority.
 */
export type ResourceWindowDeps = {
  /** The account this window is signed in to now. */
  account(): string | null;
  /** The assistant this window's voice notes go to now (null: none set up here yet). */
  contextAssistant(): string | null;
  /** This window's own job for the note, if it has one: its phase. */
  jobPhase(noteId: string): string | null;
  retry(noteId: string): Promise<void>;
  forget(noteId: string): void;
  confirm(words: { title: string; description: string; confirmLabel: string }): Promise<boolean>;
  t(key: string, ns: 'assistant' | 'voiceNotes', values?: Record<string, string>): string;
  saveTextFile(args: { title: string; defaultPath: string; content: string }): Promise<{ success: boolean; path?: string }>;
  wait(ms: number): Promise<void>;
};

const WORKING = new Set(['recording', 'uploading', 'transcribing', 'summarizing']);
/** How long 开始转写 waits for this window's voice-note host to come up for the assistant before saying not ready. */
export const CONTEXT_WAIT_MS = 3000;

export function createResourceWindow(deps: ResourceWindowDeps) {
  return {
    /** The page's question, in its words; a voice note's own job here stopped first on yes (it would write the folder back). */
    async confirmRemoval(ask: ResourceRemovalAsk): Promise<boolean> {
      if (ask.kind === 'voice-note' && deps.account() !== ask.ownerId) return false;
      const words = ask.kind === 'folder'
        ? { title: deps.t('files.deleteFolderTitle', 'assistant'), description: deps.t('files.deleteFolderBody', 'assistant', { name: ask.name }), confirmLabel: deps.t('common.delete', 'assistant') }
        : { title: deps.t('deleteTitle', 'voiceNotes', { name: ask.title ?? deps.t('untitled', 'voiceNotes') }), description: deps.t('deleteBody', 'voiceNotes'), confirmLabel: deps.t('delete', 'voiceNotes') };
      const yes = await deps.confirm(words);
      if (yes && ask.kind === 'voice-note') {
        if (deps.account() !== ask.ownerId) return false;
        if (deps.contextAssistant() === ask.assistantId) deps.forget(ask.noteId);
      }
      return yes;
    },
    /** The page's 开始转写 (`retryVoiceNote`): read back from the store, transcribed here, handed to the assistant to sum up. */
    async transcribe(ask: VoiceNoteTranscribeAsk): Promise<VoiceNoteTranscribeOutcome> {
      if (deps.account() !== ask.ownerId) return 'denied';
      for (let waited = 0; deps.contextAssistant() !== ask.assistantId; waited += 250) {
        if (waited >= CONTEXT_WAIT_MS) return 'not-ready';
        await deps.wait(250);
        if (deps.account() !== ask.ownerId) return 'denied';
      }
      const phase = deps.jobPhase(ask.noteId);
      if (phase && WORKING.has(phase)) return 'busy';
      try {
        await deps.retry(ask.noteId);
      } catch {
        return 'not-ready';
      }
      return 'started';
    },
    /** The page's 导出 Markdown: its file name, its Markdown, the host's save dialog. */
    async exportNote(ask: VoiceNoteExportAsk): Promise<VoiceNoteExportOutcome> {
      if (deps.account() !== ask.ownerId) return 'denied';
      const title = ask.title ?? deps.t('untitled', 'voiceNotes');
      const saved = await deps.saveTextFile({
        title: deps.t('exportTitle', 'voiceNotes'),
        defaultPath: exportFileName(title),
        content: exportMarkdown({ title, summary: ask.summary, lines: ask.transcript ? parseTranscript(ask.transcript) : [] }),
      });
      if (!saved.success) return 'failed';
      return saved.path ? 'saved' : 'cancelled';
    },
  };
}
export type ResourceWindow = ReturnType<typeof createResourceWindow>;
