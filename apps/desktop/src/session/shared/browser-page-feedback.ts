import type { ProjectionPresentation, ProjectionTarget } from './extensions/projection-presentation';

type Point = { x: number; y: number; click?: string };
type Snapshot = { target: ProjectionTarget; stamp: number; at?: number; cursor?: Point; action?: NonNullable<ProjectionPresentation['action']> };
const pages = new WeakMap<object, BrowserPageFeedback>();

/** The real page object is the key. App arguments never choose the target or another page's feedback. */
export function browserPageFeedback(page: object): BrowserPageFeedback {
  let feedback = pages.get(page);
  if (!feedback) { feedback = new BrowserPageFeedback(); pages.set(page, feedback); }
  return feedback;
}

export class BrowserPageFeedback {
  private readonly id = `browser:${crypto.randomUUID()}`;
  private revision = 1;
  private stamp = 0;
  private serial = 0;
  private cursor: Point | undefined;
  private gesture: string | undefined;
  private clock: (() => Promise<number>) | undefined;
  private clockSerial = 0;
  private at: number | undefined;
  private lastTime = 0;
  private action: NonNullable<ProjectionPresentation['action']> | undefined;
  private callAction: NonNullable<ProjectionPresentation['action']> | undefined;
  private readonly calls = new Map<AbortSignal, string>();
  private operation() { return this.callAction ?? this.action; }
  private readonly listeners = new Set<() => void>();

  snapshot(): Snapshot {
    return { target: { id: this.id, revision: this.revision }, stamp: this.stamp,
      ...(this.at === undefined ? {} : { at: this.at }),
      ...(this.cursor ? { cursor: { ...this.cursor } } : {}), ...(this.operation() ? { action: { ...this.operation()! } } : {}) };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.stamp++; for (const listener of this.listeners) { try { listener(); } catch { /* Presentation cannot fail input. */ } } }
  invalidate(): void {
    this.revision++; this.clockSerial++; this.at = undefined; this.gesture = undefined; this.cursor = this.action = undefined;
    if (!this.calls.size) this.callAction = undefined;
    this.changed();
    if (this.callAction) this.correlate(this.callAction.id, this.revision);
  }
  /** Starts only when that call actually dispatched through this exact page lease. Normal completion aborts this signal too. */
  followCall(signal: AbortSignal): () => void {
    if (signal.aborted || this.calls.has(signal) || this.calls.size >= 128) return () => {};
    const id = `call-${++this.serial}`;
    this.calls.set(signal, id);
    this.callAction = { id, label: '正在操作网页', phase: 'running' };
    this.at = undefined; this.changed(); this.correlate(id, this.revision);
    let live = true;
    const stop = (finished: boolean) => {
      if (!live) return; live = false; signal.removeEventListener('abort', ended); this.calls.delete(signal);
      const active = [...this.calls.values()].at(-1);
      this.callAction = active ? { id: active, label: '正在操作网页', phase: 'running' }
        : finished ? { id, label: '网页操作已结束', phase: 'done' } : undefined;
      this.at = undefined; this.changed();
      if (this.callAction) this.correlate(this.callAction.id, this.revision);
    };
    const ended = () => stop(true);
    signal.addEventListener('abort', ended, { once: true });
    return () => stop(false);
  }
  useClock(read: () => Promise<number>): void { this.clock = read; }
  private correlate(id: string, revision: number): void {
    if (!this.clock) return;
    const serial = ++this.clockSerial;
    this.at = undefined;
    void Promise.resolve().then(this.clock).then(at => {
      if (serial !== this.clockSerial || revision !== this.revision || this.operation()?.id !== id) return;
      if (!Number.isFinite(at) || at <= 0 || at < this.lastTime) {
        // Do not turn a missing/backwards clock into a retry loop or a guessed association.
        this.revision++; this.clockSerial++; this.at = undefined; this.cursor = this.action = undefined; this.changed(); return;
      }
      this.lastTime = at; this.at = at; this.changed();
    }, () => { if (serial === this.clockSerial) { this.at = undefined; this.changed(); } });
  }

  /** Called after actual native dispatch. A cursor moves only after that native result succeeds. */
  dispatched(method: string, params: Record<string, unknown>, native: Promise<unknown>, child = false): void {
    if (!['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.navigate', 'Page.reload',
      'Page.captureScreenshot', 'Accessibility.getFullAXTree'].includes(method)) return;
    // Child-frame coordinates are not root-page coordinates; never pretend they are.
    if (child) { this.invalidate(); return; }
    const pointer = method === 'Input.dispatchMouseEvent';
    const verb = pointer ? params.type === 'mouseMoved' ? '移动光标' : params.type === 'mouseWheel' ? '滚动' : '点击'
      : method === 'Input.insertText' ? '输入' : method === 'Input.dispatchKeyEvent' ? '按键'
        : method === 'Page.navigate' ? '打开网页' : method === 'Page.reload' ? '刷新网页' : '查看网页';
    const id = `dispatch-${++this.serial}`, revision = this.revision;
    if (pointer) this.cursor = undefined;
    this.at = undefined; this.action = { id, label: `正在${verb}`, phase: 'running' }; this.changed(); this.correlate(this.operation()!.id, revision);
    void native.then(() => {
      if (this.revision !== revision || this.action?.id !== id) return;
      if (pointer && typeof params.x === 'number' && Number.isFinite(params.x) && params.x >= 0
        && typeof params.y === 'number' && Number.isFinite(params.y) && params.y >= 0) {
        if (params.type === 'mousePressed') this.gesture = id;
        else if (params.type !== 'mouseReleased') this.gesture = undefined;
        this.cursor = { x: params.x, y: params.y, ...(this.gesture ? { click: this.gesture } : {}) };
      }
      this.at = undefined; this.action = { id, label: `已${verb}`, phase: 'done' }; this.changed(); this.correlate(this.operation()!.id, revision);
    }, () => {
      if (this.revision !== revision || this.action?.id !== id) return;
      // Native dispatch errors can have an unknown execution outcome. Do not label one as a confirmed failed action.
      this.clockSerial++; this.at = undefined; this.cursor = this.action = undefined; this.changed();
      if (this.callAction) this.correlate(this.callAction.id, this.revision);
    });
  }
}

/** Only observations stable across capture can decorate that capture. */
export function browserFrameFeedback(before: Snapshot, after: Snapshot, width: number, height: number) {
  if (before.stamp !== after.stamp || before.target.id !== after.target.id || before.target.revision !== after.target.revision) return undefined;
  const cursor = after.cursor && after.cursor.x < width && after.cursor.y < height ? after.cursor : undefined;
  return { target: after.target,
    ...(cursor ? { cursor } : {}), ...(after.action ? { action: after.action } : {}) };
}

/** Browser-generated monotonic frame time, in the same domain as Performance.Timestamp. No receipt-time guessing. */
export function browserScreencastFeedback(snapshot: Snapshot, frameTime: unknown, width: number, height: number,
  pageScale: unknown, offsetTop: unknown) {
  if (snapshot.at === undefined || typeof frameTime !== 'number' || !Number.isFinite(frameTime) || frameTime < snapshot.at) return undefined;
  const value = browserFrameFeedback(snapshot, snapshot, width, height);
  // The existing source/input path is unchanged. Ambiguous scaled coordinates never get a guessed cursor.
  if (value && (pageScale !== 1 || offsetTop !== 0)) delete value.cursor;
  return value;
}
