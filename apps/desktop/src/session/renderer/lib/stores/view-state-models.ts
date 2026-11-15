/**
 * Every kind of view-state entry that reaches the disk, with its caps (client state model: a persisted model declares its
 * limits). The whole store is handed to the renderer synchronously before its first frame, so its worst case — the sum
 * of every model's maxBytes — must stay under VIEW_STATE_BUDGET_BYTES; a test adds it up.
 *
 * maxBytes bounds a model's entries together (key plus serialized value, in UTF-16 units), not each one: a single entry
 * may use all of it (one long draft is kept whole). Over maxEntries or maxBytes, a model drops its least recently written
 * entries until it fits. An entry larger than maxBytes on its own is not stored: it is logged once, stays in memory, and
 * its last stored copy stays. A key no model claims is refused: a new persisted entry declares its caps here first.
 *
 * Per-conversation entries are capped, so the store no longer grows with the number of chats. 256 KB is read in about
 * 2 ms by the first synchronous call of a fresh renderer (measured on Electron's sendSync, gpu rig 11-15).
 */
export const VIEW_STATE_BUDGET_BYTES = 256 * 1024;

export interface ViewStateModel {
  name: string;
  match: RegExp;
  maxEntries: number;
  /** All of this model's entries together, serialized. */
  maxBytes: number;
}

// View-state table entries are `view:<account>/<conversation>/<panel>` (lib/viewStateTable). A chat strip is about 500
// bytes a pane plus 150-300 a tab.
export const VIEW_STATE_MODELS: readonly ViewStateModel[] = [
  { name: 'navigation', match: /^navigation$/, maxEntries: 1, maxBytes: 4 * 1024 },
  // Grows with the projects and sessions shown in the sidebar (their order), hence the room.
  { name: 'sidebar', match: /^sidebar$/, maxEntries: 1, maxBytes: 24 * 1024 },
  { name: 'project view', match: /^project:[^:]+$/, maxEntries: 16, maxBytes: 8 * 1024 },
  { name: 'task view', match: /^session:[^:]+$/, maxEntries: 24, maxBytes: 12 * 1024 },
  { name: 'task tabs', match: /^session:.+:tabs$/, maxEntries: 24, maxBytes: 48 * 1024 },
  { name: 'chat tabs', match: /^chat:.+:tabs$/, maxEntries: 48, maxBytes: 48 * 1024 },
  // The largest share: an unsent draft is the costliest thing to lose. One may run to about 96 000 characters.
  { name: 'draft', match: /^view:.*\/draft$/, maxEntries: 32, maxBytes: 96 * 1024 },
  { name: 'reading position', match: /^view:.*\/reading:.*$/, maxEntries: 64, maxBytes: 8 * 1024 },
  { name: 'members panel', match: /^view:.*\/members$/, maxEntries: 32, maxBytes: 4 * 1024 },
];

export function viewStateModelOf(key: string): ViewStateModel | null {
  return VIEW_STATE_MODELS.find((model) => model.match.test(key)) ?? null;
}
