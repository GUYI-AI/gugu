import { exportFileName, exportMarkdown, parseTranscript } from '@gugu/core/shared/voiceNotes';
import type {
  ResourceRemovalAsk, VoiceNoteExportAsk, VoiceNoteExportOutcome, VoiceNoteTranscribeAsk, VoiceNoteTranscribeOutcome,
} from '@shared/extensions/host-actions';

/**
 * #50 This window's half of an App's managing calls (app-bound-resources-manage.ts in main): the assistant page's own
 * question before a delete, its 开始转写 and its 导出 Markdown — the same words, the same pipeline, the same save dialog.
 * The window checks the account (and, for a voice note, the assistant) it has itself; main checked the App's authority.
 */
export type ResourceWindowDeps = {
  /** The account this window is signed in to now. */
  account(): string | null;
  /** The assistant this window's voice notes go to now (null: none set up here yet). */
  contextAssistant(): string | null;
  /**
   * API 47's voice-note host (app-voice-notes-active.ts): from now on this window keeps the voice-note context from its own
   * assistant data, the assistant's page open or not.
   */
  activate(): void;
  /** Resolves true when the context next changes (the assistant found, its home read), false after `ms`. */
  contextChanged(ms: number): Promise<boolean>;
  now(): number;
  /** This window's own job for the note, if it has one: its phase. */
  jobPhase(noteId: string): string | null;
  retry(noteId: string): Promise<void>;
  forget(noteId: string): void;
  confirm(words: { title: string; description: string; confirmLabel: string }): Promise<boolean>;
  t(key: string, ns: 'assistant' | 'voiceNotes', values?: Record<string, string>): string;
  saveTextFile(args: { title: string; defaultPath: string; content: string }): Promise<{ success: boolean; path?: string }>;
};

const WORKING = new Set(['recording', 'uploading', 'transcribing', 'summarizing']);
/**
 * How long 开始转写 waits for this window to have the assistant's home in hand (API 47's host reading it, a cloud home
 * answering) before saying not ready — inside main's 30 s for a window's answer.
 */
export const TRANSCRIBE_WAIT_MS = 15_000;

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
    /**
     * The page's 开始转写 (`retryVoiceNote`): read back from the assistant's home, transcribed here, handed to it to sum
     * up. API 47's host keeps the context, so the assistant's page need not be open; until the home is read (the
     * pipeline refuses before that), it is tried again on each change of the context.
     */
    async transcribe(ask: VoiceNoteTranscribeAsk): Promise<VoiceNoteTranscribeOutcome> {
      if (deps.account() !== ask.ownerId) return 'denied';
      deps.activate();
      const deadline = deps.now() + TRANSCRIBE_WAIT_MS;
      for (;;) {
        if (deps.contextAssistant() === ask.assistantId) {
          const phase = deps.jobPhase(ask.noteId);
          if (phase && WORKING.has(phase)) return 'busy';
          try {
            await deps.retry(ask.noteId);
            return 'started';
          } catch {
            // Its home not read here yet: the next change of the context may bring it.
          }
        }
        const left = deadline - deps.now();
        if (left <= 0 || !(await deps.contextChanged(left))) return deps.account() === ask.ownerId ? 'not-ready' : 'denied';
        if (deps.account() !== ask.ownerId) return 'denied';
      }
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
