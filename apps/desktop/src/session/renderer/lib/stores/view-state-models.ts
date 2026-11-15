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
 * Kinds are capped per device, shared by every account on it: with several accounts the least recently written goes
 * first, whichever account wrote it. Per-conversation entries are capped, so the store no longer grows with the number of chats. 256 KB is read in about
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
  { name: 'sidebar', match: /^sidebar$/, maxEntries: 1, maxBytes: 16 * 1024 },
  { name: 'project view', match: /^project:[^:]+$/, maxEntries: 16, maxBytes: 4 * 1024 },
  { name: 'task view', match: /^session:[^:]+$/, maxEntries: 24, maxBytes: 8 * 1024 },
  { name: 'task tabs', match: /^session:.+:tabs$/, maxEntries: 24, maxBytes: 32 * 1024 },
  { name: 'chat tabs', match: /^chat:.+:tabs$/, maxEntries: 48, maxBytes: 32 * 1024 },
  // The largest share: an unsent draft is the costliest thing to lose. One may run to about 96 000 characters.
  { name: 'draft', match: /^view:.*\/draft$/, maxEntries: 32, maxBytes: 96 * 1024 },
  { name: 'reading position', match: /^view:.*\/reading:.*$/, maxEntries: 64, maxBytes: 8 * 1024 },
  { name: 'members panel', match: /^view:.*\/members$/, maxEntries: 32, maxBytes: 4 * 1024 },
  // A key with its account and chat ids is about 120 characters: some 30 fit.
  { name: 'last mention', match: /^view:.*\/mention-recall$/, maxEntries: 32, maxBytes: 4 * 1024 },
  { name: 'recent searches', match: /^view:.*\/search-recent$/, maxEntries: 32, maxBytes: 4 * 1024 },
  // Per account: which blocks are on screen (bounded by the screen's block count).
  { name: 'screen layout', match: /^view:[^/]*\/\/screen$/, maxEntries: 2, maxBytes: 16 * 1024 },
  { name: 'app placement', match: /^view:[^/]*\/\/app-placement$/, maxEntries: 2, maxBytes: 2 * 1024 },
  // Each account's entry is trimmed to 2.8 KB (tab-placement-memory): two accounts fit.
  { name: 'tab placement', match: /^view:[^/]*\/\/tab-placement$/, maxEntries: 2, maxBytes: 6 * 1024 },
  { name: 'participant panes', match: /^view:[^/]*\/\/participant-panes$/, maxEntries: 2, maxBytes: 6 * 1024 },
  { name: 'recent tasks', match: /^view:[^/]*\/\/recent-tasks$/, maxEntries: 2, maxBytes: 2 * 1024 },
  // Small settings of the interface itself: pane widths, folds, which side panel is open, a preview's zoom.
  { name: 'interface', match: /^view:[^/]*\/[^/]*\/ui:[^/]+$/, maxEntries: 48, maxBytes: 6 * 1024 },
];

export function viewStateModelOf(key: string): ViewStateModel | null {
  return VIEW_STATE_MODELS.find((model) => model.match.test(key)) ?? null;
}
