import { useAssistantMachine } from '../assistant-data';
import { useAssistantShell } from '../assistant-shell';
import { useVoiceNotesContext } from './voice-recording-bar';

/**
 * #1927 (47) The recorder's assistant context while an App drives it (`gugu.voiceNote`), from the same shell data the
 * assistant's page reads (who the personal assistant is, where it lives, its private conversation) — never from the App.
 * Sets only the context: the composer's 「录制语音笔记」 and the meeting reminder still follow the assistant's page.
 */
export default function AppVoiceNotesContext() {
  const shell = useAssistantShell();
  const assistantId = shell?.assistant?.id ?? null;
  const home = shell?.assistant ? shell.home : null;
  const machine = useAssistantMachine(assistantId, shell?.chatId ?? null, home, shell?.chatReadFailed);
  useVoiceNotesContext({ home, assistantId, ownerName: shell?.ownerName ?? null, machine: machine.data });
  return null;
}
