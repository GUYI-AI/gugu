import { lazy, Suspense, useSyncExternalStore } from 'react';
import { appVoiceNotesActive } from './app-voice-notes-active';

const AppVoiceNotesContext = lazy(() => import('./app-voice-notes-context'));

/** #1927 (47) Mounted once at the session app's root: nothing until an App asks for the recorder (app-voice-notes-active.ts). */
export function AppVoiceNotesHost() {
  const active = useSyncExternalStore(appVoiceNotesActive.subscribe, appVoiceNotesActive.get);
  return active ? <Suspense fallback={null}><AppVoiceNotesContext /></Suspense> : null;
}
