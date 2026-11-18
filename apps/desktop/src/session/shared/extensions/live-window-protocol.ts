/** Passive host-owned resource descriptions; these records never grant picture/input access. */
export type LiveWindowResourceDescriptor = {
  id: string;
  sessionId: string;
  title: string;
  size: { width: number; height: number } | null;
  /** Order of the host's admitted Agent call, never a viewer/frame timestamp. */
  activity?: number;
} & (
  | { type: 'task-page' }
  | { type: 'app-projection'; appId: string; appVersion: string }
);
export const LIVE_WINDOW_SOURCES_CHANGED = 'appProjection.sourcesChanged';
