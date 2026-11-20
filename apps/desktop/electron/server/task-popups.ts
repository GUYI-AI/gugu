/** How long a window Chrome already opened waits for the Gugu tab that will show it. */
export const POPUP_CLAIM_MS = 5_000;

type Held = { targetId: string; timer: ReturnType<typeof setTimeout> };

/**
 * Windows a page opened (window.open, target=_blank) that Chrome has already created. Gugu shows each one as a new tab:
 * that tab adopts the window instead of loading the address again, so the window keeps `window.opener`, the address is
 * requested once, and `window.open` hands the page a real window. A window nobody takes is closed.
 *
 * The new tab is matched by the address it opens, which is the address the window was opened with.
 */
export class TaskPopups {
  private readonly held = new Map<string, Held[]>();

  constructor(private readonly close: (targetId: string) => void, private readonly claimMs = POPUP_CLAIM_MS) {}

  /** The same address however it is written; an empty window is about:blank. */
  private static key(url: string): string {
    if (url === '' || url === 'about:blank') return 'about:blank';
    try { return new URL(url).href; } catch { return url; }
  }

  hold(url: string, targetId: string): void {
    const key = TaskPopups.key(url);
    const timer = setTimeout(() => {
      this.drop(key, targetId);
      this.close(targetId);
    }, this.claimMs);
    timer.unref?.();
    this.held.set(key, [...(this.held.get(key) ?? []), { targetId, timer }]);
  }

  /** The oldest waiting window with this address, now the caller's; null when there is none. */
  take(url: string | undefined): string | null {
    if (!url) return null;
    const key = TaskPopups.key(url);
    const first = this.held.get(key)?.[0];
    if (!first) return null;
    clearTimeout(first.timer);
    this.drop(key, first.targetId);
    return first.targetId;
  }

  /** Chrome closed it already (the page called close()). */
  forget(targetId: string): void {
    for (const [key, list] of this.held) {
      const found = list.find(item => item.targetId === targetId);
      if (!found) continue;
      clearTimeout(found.timer);
      this.drop(key, targetId);
    }
  }

  dispose(): void {
    for (const list of this.held.values()) for (const item of list) clearTimeout(item.timer);
    this.held.clear();
  }

  private drop(key: string, targetId: string): void {
    const rest = (this.held.get(key) ?? []).filter(item => item.targetId !== targetId);
    if (rest.length) this.held.set(key, rest); else this.held.delete(key);
  }
}
