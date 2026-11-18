import { useEffect, useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { useAssistantShell } from '../assistant/assistant-shell';
import { appVoiceNotesActive } from '../assistant/voice-notes/app-voice-notes-active';
import { subscribeVoiceNotesContext, voiceNotesAssistantId } from '../assistant/voice-notes/voice-note-jobs';
import { VoiceBar } from '../assistant/voice-notes/voice-recording-bar';

/**
 * #1927 (API 48) The host's recording bar in the column of an App placed beside the person's own assistant chat — the
 * built-in assistant page's bar (VoiceBar), drawn the same way above the composer, whichever side started the recording:
 * the composer's entry, the App's `gugu.voiceNote`, the rail. Only while that column is this account's private chat with its
 * assistant and the recorder's notes go to that assistant. Opening the note it shows asks the App's page to show it
 * (`voice-note`, on `gugu.bindings.onSurface`), as the built-in opens it in its own panel; nothing else of it reaches the App.
 */
export default function AppConversationVoiceBar({ extensionId, chatId, column }: { extensionId: string; chatId: string; column: HTMLElement | null }) {
  const shell = useAssistantShell();
  const assistant = shell?.chatId === chatId ? shell.assistant : null;
  const recorderFor = useSyncExternalStore(subscribeVoiceNotesContext, voiceNotesAssistantId);
  // Where its notes go is read from the host's own assistant data, as the assistant page sets it (app-voice-notes-context.tsx).
  useEffect(() => { if (assistant) appVoiceNotesActive.activate(); }, [assistant]);
  const ownerId = shell?.ownerId ?? null;
  if (!assistant || recorderFor !== assistant.id || !ownerId) return null;
  const open = () => {
    void rpc.extensions.conversationVoiceNoteOpened({ ownerId, extensionId }).then((result) => {
      if (!result.success) log.warn('The App could not be asked to show the voice note:', result.error);
    }, (error: unknown) => log.warn('The App could not be asked to show the voice note:', error));
  };
  return <VoiceBar assistantName={assistant.display_name} onOpen={open} column={column} />;
}
