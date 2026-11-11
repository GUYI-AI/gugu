/**
 * #1927 (47) Whether an App has asked for the voice-note recorder in this window (`gugu.voiceNote`): from then on this
 * window keeps the recorder's assistant context from its own assistant-home data (app-voice-notes-context.tsx), as the
 * assistant's page does while it is up. Kept apart so the session app's root reads it without loading the recorder.
 */
let active = false;
const listeners = new Set<() => void>();

export const appVoiceNotesActive = {
  get: (): boolean => active,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  activate(): void {
    if (active) return;
    active = true;
    for (const listener of listeners) listener();
  },
};
