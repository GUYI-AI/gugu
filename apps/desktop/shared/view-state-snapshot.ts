// @@@view-state-snapshot — the view state (③: drafts, reading positions, tabs, what is folded) reaches the renderer before its
// first frame: preload asks main for every stored entry over this synchronous channel, as it does for the host's system
// languages (host-localization.ts). Main answers from its database (better-sqlite3 is synchronous), oldest write first.
export const VIEW_STATE_SNAPSHOT_CHANNEL = 'view-state:snapshot'

/** What preload exposes on `window`: the snapshot, or null when main had none to give (the session page backend is down). */
export const VIEW_STATE_GLOBAL = 'guguViewState'
export type ViewStateGlobal = { snapshot: Record<string, unknown> | null }
