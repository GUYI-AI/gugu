/**
 * #1607 node 5 — a task's browser page that lives on another of the person's computers (a Gugu server's headless
 * Chromium), shown in this session's browser tab with the same toolbar as a page on this computer: what that toolbar
 * shows, and what the person can do from it.
 */
export type TaskPageState = {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type TaskPageControl =
  | { action: 'navigate'; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop' }
  /** The tab's size in CSS pixels and its device pixel ratio: the page lays out to fill it, as it would in the tab here. */
  | { action: 'resize'; width: number; height: number; scale: number };

const ACTIONS = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'resize']);
const size = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** A control as it arrives from another computer; null when it is not one. */
export function readTaskPageControl(value: unknown): TaskPageControl | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.action !== 'string' || !ACTIONS.has(body.action)) return null;
  if (body.action === 'navigate') return typeof body.url === 'string' && body.url.length <= 8192 ? { action: 'navigate', url: body.url } : null;
  if (body.action === 'resize') {
    return size(body.width, 100, 8000) && size(body.height, 100, 8000) && size(body.scale, 0.5, 4)
      ? { action: 'resize', width: Math.round(body.width as number), height: Math.round(body.height as number), scale: body.scale as number }
      : null;
  }
  return { action: body.action as 'back' | 'forward' | 'reload' | 'stop' };
}
