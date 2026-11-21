/** How long a window Chrome already opened waits for the Gugu tab that will show it. */
export const POPUP_CLAIM_MS = 5_000;
/** How long Gugu remembers a window that closed itself before its tab opened. */
export const POPUP_CLOSED_MS = 10_000;

/** The tab was opened for a window the page had already closed: there is nothing to show and the address must not load again. */
export class TaskPopupClosed extends Error {
  constructor(readonly url: string) { super(`The window opened for ${url} closed before its tab opened`); }
}

/** A newly created page closed during attachment, before its desktop tab had a page to show. */
export class TaskPageClosedDuringOpen extends Error {
  override name = 'TaskPageClosedDuringOpen';

  constructor(cause?: unknown) { super('The page closed before its tab opened', { cause }); }
}

/**
 * Windows a page opened (window.open, target=_blank) that Chrome has already created. Gugu shows each one as a new tab:
 * that tab adopts the window instead of loading the address again, so the window keeps `window.opener`, the address is
 * requested once, and `window.open` hands the page a real window. A window nobody takes is closed.
 *
 * The tab is opened for one particular window and claims it by that window's id (Chrome's target id): never by address,
 * because an empty window and a blank tab the person opens are both about:blank and must not be mistaken for each other.
 */
export class TaskPopups {
  private readonly held = new Map<string, ReturnType<typeof setTimeout>>();
  /** Windows that closed themselves before a tab took them, with when. */
  private readonly closedEarly = new Map<string, number>();

  constructor(private readonly close: (targetId: string) => void, private readonly claimMs = POPUP_CLAIM_MS) {}

  hold(targetId: string): void {
    const timer = setTimeout(() => {
      this.held.delete(targetId); // Gugu closes it: nothing to tell a tab that comes later, it opens the address itself.
      this.close(targetId);
    }, this.claimMs);
    timer.unref?.();
    this.held.set(targetId, timer);
  }

  /** The tab opened for this window claims it: true when it is still waiting, and now the caller's. */
  take(targetId: string | undefined): boolean {
    const timer = targetId === undefined ? undefined : this.held.get(targetId);
    if (!timer || targetId === undefined) return false;
    clearTimeout(timer);
    this.held.delete(targetId);
    return true;
  }

  /** Chrome closed it already (the page called close()). */
  forget(targetId: string): void {
    const timer = this.held.get(targetId);
    if (!timer) return;
    clearTimeout(timer);
    this.held.delete(targetId);
    const now = Date.now();
    for (const [id, at] of this.closedEarly) if (now - at > POPUP_CLOSED_MS) this.closedEarly.delete(id);
    this.closedEarly.set(targetId, now);
  }

  /** Whether this window closed itself before any tab took it. Told once, and only for a few seconds. */
  closedBeforeTaken(targetId: string | undefined): boolean {
    const at = targetId === undefined ? undefined : this.closedEarly.get(targetId);
    if (at === undefined || targetId === undefined) return false;
    this.closedEarly.delete(targetId);
    return Date.now() - at <= POPUP_CLOSED_MS;
  }

  dispose(): void {
    for (const timer of this.held.values()) clearTimeout(timer);
    this.held.clear();
    this.closedEarly.clear();
  }
}
