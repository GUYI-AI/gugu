import { browserFrameFeedback, type BrowserPageFeedback } from '@shared/browser-page-feedback';
import type { TaskPageScreenFrame } from './server-task-browser';

export type CaptureDocument = { id: string; controller: AbortController };
type CaptureCommand = (method: string, params: Record<string, unknown> | undefined, document: CaptureDocument) => Promise<unknown>;

export class CaptureReplyTimeout extends Error {
  constructor(method: string, readonly requestId: number, readonly timeoutMs: number) {
    super(`${method} did not reply within ${timeoutMs} ms`);
  }
}

type Viewport = { frame: string; loader: string; width: number; height: number; x: number; y: number; scale: number };

async function viewport(send: CaptureCommand, document: CaptureDocument): Promise<Viewport> {
  const tree = await send('Page.getFrameTree', undefined, document) as { frameTree: { frame: { id: string; loaderId: string } } };
  const metrics = await send('Page.getLayoutMetrics', undefined, document) as {
    cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number; scale: number };
  };
  const view = metrics.cssVisualViewport;
  if (!view || ![view.clientWidth, view.clientHeight, view.pageX, view.pageY, view.scale].every(Number.isFinite)
    || view.clientWidth <= 0 || view.clientHeight <= 0 || view.scale <= 0 || !tree.frameTree.frame.loaderId) {
    throw new Error('The task browser viewport is unavailable');
  }
  return { frame: tree.frameTree.frame.id, loader: tree.frameTree.frame.loaderId,
    width: view.clientWidth, height: view.clientHeight, x: view.pageX, y: view.pageY, scale: view.scale };
}

/** A requested screenshot, rather than an older queued screencast picture, carries stable feedback.
 * Chromium versions without a monotonic screencast timestamp use the same page/session and capture API.
 * One capture is in flight across stop/start; late results cannot publish into a new viewing generation.
 */
export class TaskPageCapture {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private captureFailed = false;

  constructor(private readonly send: CaptureCommand, private readonly currentDocument: () => CaptureDocument,
    private readonly feedback: BrowserPageFeedback,
    private readonly available: () => boolean, private readonly failed: (error: unknown) => void) {}

  async start(publish: (frame: TaskPageScreenFrame) => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const live = () => generation === this.generation && this.available();
    const capture = async () => {
      if (!live()) return;
      const document = this.currentDocument();
      const signal = document.controller.signal;
      let delay = 250;
      try {
        const before = this.feedback.snapshot();
        const first = await viewport(this.send, document);
        if (!live()) return;
        const picture = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true,
          captureBeyondViewport: false, clip: { x: first.x, y: first.y, width: first.width, height: first.height,
            scale: Math.min(1, 1600 / Math.max(first.width, first.height)) } }, document) as { data: string };
        const last = await viewport(this.send, document);
        if (!live() || signal.aborted || JSON.stringify(first) !== JSON.stringify(last)) return;
        const width = Math.round(first.width), height = Math.round(first.height);
        const feedback = browserFrameFeedback(before, this.feedback.snapshot(), width, height);
        if (feedback && first.scale !== 1) delete feedback.cursor;
        publish({ data: picture.data, width, height, ...(feedback ? { feedback } : {}) });
        this.captureFailed = false;
      } catch (error) {
        if (error instanceof CaptureReplyTimeout) {
          // The expired request has already been logged and removed from the pipe's pending replies.
          delay = 0;
        } else if (live() && !signal.aborted && !this.captureFailed) { this.captureFailed = true; this.failed(error); }
      } finally {
        if (live()) {
          this.timer = setTimeout(() => { this.tail = this.tail.then(capture); }, delay);
          this.timer.unref?.();
        }
      }
    };
    this.tail = this.tail.then(capture);
    await this.tail;
  }

  stop(): void { this.generation++; clearTimeout(this.timer); this.timer = undefined; }
}
