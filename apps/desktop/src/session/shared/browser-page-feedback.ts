import type { ProjectionPresentation, ProjectionTarget } from './extensions/projection-presentation';
import { FALLBACK_LOCALE, matchSupportedLocale } from '@/i18n/locale';
import { hostCatalog } from '../../../shared/host-localization';

type Point = { x: number; y: number; click?: string };
type Snapshot = { target: ProjectionTarget; stamp: number; cursor?: Point; action?: NonNullable<ProjectionPresentation['action']> };
const pages = new WeakMap<object, BrowserPageFeedback>();

type BrowserPageVerb = keyof ReturnType<typeof hostCatalog>['browserFeedback']['running'];

/**
 * The real page object is the key. App arguments never choose the target or another page's feedback.
 * `locale` is the host's language: each action caption is written in it when the action happens.
 */
export function browserPageFeedback(page: object, locale: () => string): BrowserPageFeedback {
  let feedback = pages.get(page);
  if (!feedback) { feedback = new BrowserPageFeedback(locale); pages.set(page, feedback); }
  return feedback;
}

export class BrowserPageFeedback {
  private readonly id = `browser:${crypto.randomUUID()}`;
  private revision = 1;
  private stamp = 0;
  private serial = 0;
  private cursor: Point | undefined;
  private gesture: string | undefined;
  private action: NonNullable<ProjectionPresentation['action']> | undefined;
  private callAction: NonNullable<ProjectionPresentation['action']> | undefined;
  private readonly calls = new Map<AbortSignal, string>();
  private operation() { return this.callAction ?? this.action; }
  private readonly listeners = new Set<() => void>();
  constructor(private readonly locale: () => string) {}
  private copy() { return hostCatalog(matchSupportedLocale(this.locale()) ?? FALLBACK_LOCALE).browserFeedback; }

  snapshot(): Snapshot {
    return { target: { id: this.id, revision: this.revision }, stamp: this.stamp,
      ...(this.cursor ? { cursor: { ...this.cursor } } : {}), ...(this.operation() ? { action: { ...this.operation()! } } : {}) };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.stamp++; for (const listener of this.listeners) { try { listener(); } catch { /* Presentation cannot fail input. */ } } }
  invalidate(): void {
    this.revision++; this.gesture = undefined; this.cursor = this.action = undefined;
    if (!this.calls.size) this.callAction = undefined;
    this.changed();
  }
  /** Starts only when that call actually dispatched through this exact page lease. Normal completion aborts this signal too. */
  followCall(signal: AbortSignal): () => void {
    if (signal.aborted || this.calls.has(signal) || this.calls.size >= 128) return () => {};
    const id = `call-${++this.serial}`;
    this.calls.set(signal, id);
    this.callAction = { id, label: this.copy().operating, phase: 'running' };
    this.changed();
    let live = true;
    const stop = (finished: boolean) => {
      if (!live) return; live = false; signal.removeEventListener('abort', ended); this.calls.delete(signal);
      const active = [...this.calls.values()].at(-1);
      this.callAction = active ? { id: active, label: this.copy().operating, phase: 'running' }
        : finished ? { id, label: this.copy().finished, phase: 'done' } : undefined;
      this.changed();
    };
    const ended = () => stop(true);
    signal.addEventListener('abort', ended, { once: true });
    return () => stop(false);
  }

  /** Called after actual native dispatch. A cursor moves only after that native result succeeds. */
  dispatched(method: string, params: Record<string, unknown>, native: Promise<unknown>, child = false): void {
    if (!['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.navigate', 'Page.reload',
      'Page.captureScreenshot', 'Accessibility.getFullAXTree'].includes(method)) return;
    // Child-frame coordinates are not root-page coordinates; never pretend they are.
    if (child) { this.invalidate(); return; }
    const pointer = method === 'Input.dispatchMouseEvent';
    const verb: BrowserPageVerb = pointer ? params.type === 'mouseMoved' ? 'move' : params.type === 'mouseWheel' ? 'scroll' : 'click'
      : method === 'Input.insertText' ? 'type' : method === 'Input.dispatchKeyEvent' ? 'key'
        : method === 'Page.navigate' ? 'navigate' : method === 'Page.reload' ? 'reload' : 'view';
    const id = `dispatch-${++this.serial}`, revision = this.revision;
    if (pointer) { this.cursor = undefined; if (params.type === 'mousePressed') this.gesture = undefined; }
    this.action = { id, label: this.copy().running[verb], phase: 'running' }; this.changed();
    void native.then(() => {
      if (this.revision !== revision || this.action?.id !== id) return;
      if (pointer && typeof params.x === 'number' && Number.isFinite(params.x) && params.x >= 0
        && typeof params.y === 'number' && Number.isFinite(params.y) && params.y >= 0) {
        if (params.type === 'mousePressed') this.gesture = id;
        else if (params.type !== 'mouseReleased') this.gesture = undefined;
        this.cursor = { x: params.x, y: params.y, ...(this.gesture ? { click: this.gesture } : {}) };
      }
      this.action = { id, label: this.copy().done[verb], phase: 'done' }; this.changed();
    }, () => {
      if (this.revision !== revision || this.action?.id !== id) return;
      // Native dispatch errors can have an unknown execution outcome. Do not label one as a confirmed failed action.
      this.cursor = this.action = undefined; this.changed();
    });
  }
}

/** Only observations stable across capture can decorate that capture. */
export function browserFrameFeedback(before: Snapshot, after: Snapshot, width: number, height: number) {
  if (before.stamp !== after.stamp || before.target.id !== after.target.id || before.target.revision !== after.target.revision) return undefined;
  const cursor = after.cursor && after.cursor.x < width && after.cursor.y < height ? after.cursor : undefined;
  return { target: after.target,
    ...(cursor ? { cursor } : {}), ...(after.action?.phase === 'running' ? { action: after.action } : {}) };
}
