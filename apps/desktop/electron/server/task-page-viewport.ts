type Viewport = { width: number; height: number; scale: number };

/** Host layout zoom: CSS layout grows as zoom decreases, while the picture stays pane-sized.
 * Pinch zoom only changes the visual viewport and cannot stand in for WebContents.setZoomFactor.
 */
export class TaskPageViewport {
  private viewport: Viewport | undefined;
  private factor = 1;
  private pending: Promise<void> = Promise.resolve();
  private layoutTail: Promise<unknown> = Promise.resolve();
  private firstSize!: () => void;
  private readonly sizedOnce = new Promise<void>(resolve => { this.firstSize = resolve; });
  constructor(private readonly send: (method: string, params: Record<string, unknown>) => Promise<unknown>) {}

  ready(): Promise<void> { return this.pending; }

  /** Resolves once the page has been given the size of its pane. Until then it lays out at Chrome's own window width. */
  sized(): Promise<void> { return this.sizedOnce; }

  resize(viewport: Viewport): Promise<void> {
    this.viewport = viewport;
    const applied = this.apply();
    void applied.then(this.firstSize, () => {});
    return applied;
  }

  zoom(factor: number): Promise<void> {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) throw new Error('Invalid browser zoom');
    this.factor = factor;
    return this.apply();
  }

  /** Chrome can temporarily change emulation for a screenshot, then restore the layout it saved. */
  withStableLayout<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.layoutTail.then(operation);
    this.layoutTail = next.catch(() => {});
    return next;
  }

  private apply(): Promise<void> {
    if (!this.viewport) return Promise.resolve(); // Saved zoom can arrive before the first pane measurement.
    const { width, height, scale } = this.viewport, factor = this.factor;
    const next = this.withStableLayout(async () => {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1, Math.round(width / factor)), height: Math.max(1, Math.round(height / factor)),
        deviceScaleFactor: scale * factor, mobile: false,
      });
      await this.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    });
    this.pending = next;
    return next;
  }
}
