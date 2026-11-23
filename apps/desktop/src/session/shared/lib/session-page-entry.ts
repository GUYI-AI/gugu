/**
 * The session page's account lifetime, handed from its entry to the host. A built app drops an entry module's exports,
 * so the entry publishes the pair on window when it evaluates (as `__EMDASH_SET_VISIBLE__` and the other host adapters).
 */
export interface SessionPageEntry {
  /** Restores the signed-in account's view (navigation, screen, sidebar, its stored conversations) and renders the tree. */
  mountSessionPage(): Promise<void>
  /** Drops the tree; the next mount starts from a fresh root. */
  unmountSessionPage(): void
}

declare global {
  interface Window {
    __EMDASH_SESSION_PAGE__?: SessionPageEntry
  }
}

export function publishSessionPageEntry(entry: SessionPageEntry): void {
  window.__EMDASH_SESSION_PAGE__ = entry
}

/** After the entry has evaluated: its pair, or a loud failure (the host shows its error card). */
export function sessionPageEntry(): SessionPageEntry {
  const entry = window.__EMDASH_SESSION_PAGE__
  if (!entry) throw new Error('the session page entry evaluated without publishing its mount')
  return entry
}
