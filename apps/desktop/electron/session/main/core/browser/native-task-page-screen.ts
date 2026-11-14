import { log } from '@main/lib/logger';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { browserAnnotationScript, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import type { TaskPageControl, TaskPageControlResult, TaskPageState } from '@shared/browser-task-page';
import type { TaskPageScreenTarget, TaskPageScreenFrame } from '../../../../server/server-task-browser';
import { acquireBrowserPage, type BrowserPageLease } from './browser-page-runtime';
import { browserWebContentsRegistry } from './browser-webcontents-registry';

/** A person's existing desktop tab watched from their phone; its native layout and owner stay in place. */
class NativeTaskPageScreen extends EventEmitter implements TaskPageScreenTarget {
  private lease: BrowserPageLease | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly changed = () => this.emit('state');
  private readonly destroyed = () => this.emit('destroyed');

  constructor(private readonly page: WebContents) { super(); }

  async startScreen(publish: (frame: TaskPageScreenFrame) => void): Promise<void> {
    await this.stopScreen();
    const generation = ++this.generation;
    const lease = acquireBrowserPage(this.page);
    this.lease = lease;
    if (!lease) throw new Error('The task browser tab is unavailable');
    await lease.ready;
    if (generation !== this.generation) { lease.dispose(); return; }
    lease.setActive(true);
    this.page.once('destroyed', this.destroyed);
    this.page.on('did-start-loading', this.changed).on('did-stop-loading', this.changed).on('did-navigate', this.changed)
      .on('did-navigate-in-page', this.changed).on('page-title-updated', this.changed);
    const capture = async () => {
      if (generation !== this.generation || this.page.isDestroyed()) return;
      try {
        const image = await this.page.capturePage(undefined, { stayHidden: true });
        const viewport = await this.page.executeJavaScript('({width:innerWidth,height:innerHeight})') as { width: number; height: number };
        const dimensions = image.getSize();
        const scale = Math.min(1, 1600 / Math.max(dimensions.width, dimensions.height));
        const frame = scale < 1 ? image.resize({ width: Math.round(dimensions.width * scale), height: Math.round(dimensions.height * scale) }) : image;
        if (generation === this.generation && !frame.isEmpty()) publish({ data: frame.toJPEG(75).toString('base64'), ...viewport });
      } catch (error) { if (generation === this.generation) { log.warn('Could not watch the task browser tab', { error: String(error) }); this.emit('destroyed'); } return; }
      if (generation === this.generation) { this.timer = setTimeout(() => { void capture(); }, 250); this.timer.unref?.(); }
    };
    await capture();
  }

  async stopScreen(): Promise<void> {
    this.generation++;
    clearTimeout(this.timer);
    this.lease?.dispose(); this.lease = undefined;
    if (!this.page.isDestroyed()) {
      this.page.removeListener('destroyed', this.destroyed);
      this.page.removeListener('did-start-loading', this.changed).removeListener('did-stop-loading', this.changed).removeListener('did-navigate', this.changed)
        .removeListener('did-navigate-in-page', this.changed).removeListener('page-title-updated', this.changed);
    }
  }

  isDestroyed(): boolean { return this.page.isDestroyed(); }
  state(): TaskPageState {
    return { url: this.page.getURL(), title: this.page.getTitle(), isLoading: this.page.isLoading(),
      canGoBack: this.page.navigationHistory.canGoBack(), canGoForward: this.page.navigationHistory.canGoForward() };
  }

  async input(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.page.isDestroyed()) throw new Error('The task browser tab was closed');
    if (method === 'Input.insertText') { await this.page.insertText(String(params.text ?? '')); return; }
    if (method === 'Input.dispatchMouseEvent') {
      const zoom = this.page.getZoomFactor();
      const types = { mouseMoved: 'mouseMove', mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseWheel: 'mouseWheel' } as const;
      const type = types[params.type as keyof typeof types];
      if (!type) throw new Error('Unsupported page pointer input');
      this.page.sendInputEvent({ type, x: Math.round(Number(params.x) * zoom), y: Math.round(Number(params.y) * zoom),
        button: params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left', clickCount: Number(params.clickCount ?? 1),
        ...(type === 'mouseWheel' ? { deltaX: Number(params.deltaX ?? 0), deltaY: Number(params.deltaY ?? 0), canScroll: true } : {}) });
      return;
    }
    if (method === 'Input.dispatchKeyEvent') {
      this.page.sendInputEvent({ type: params.type === 'keyUp' ? 'keyUp' : 'keyDown', keyCode: String(params.key),
        modifiers: [...(Number(params.modifiers) & 1 ? ['alt' as const] : []), ...(Number(params.modifiers) & 2 ? ['control' as const] : []),
          ...(Number(params.modifiers) & 4 ? ['meta' as const] : []), ...(Number(params.modifiers) & 8 ? ['shift' as const] : [])] });
      if (params.type !== 'keyUp' && typeof params.text === 'string') this.page.sendInputEvent({ type: 'char', keyCode: params.text });
      return;
    }
    throw new Error('Unsupported page input');
  }

  async control(control: TaskPageControl): Promise<TaskPageControlResult> {
    switch (control.action) {
      case 'annotate': {
        const target = await this.page.executeJavaScript(browserAnnotationScript(control.query)) as BrowserAnnotationTarget;
        if (!control.capture) return { target };
        const image = await this.page.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty() || this.page.getURL() !== target.url) throw new Error('The page changed during selection');
        return { target, screenshot: `data:image/png;base64,${image.toPNG().toString('base64')}` };
      }
      // Watching a native tab does not resize the person's desktop. The picture retains its viewport and fits the phone.
      case 'resize': return;
      case 'navigate': {
        const url = new URL(control.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web pages open here');
        await this.page.loadURL(url.href); return;
      }
      case 'back': if (this.page.navigationHistory.canGoBack()) this.page.navigationHistory.goBack(); return;
      case 'forward': if (this.page.navigationHistory.canGoForward()) this.page.navigationHistory.goForward(); return;
      case 'reload': this.page.reload(); return;
      case 'stop': this.page.stop(); return;
    }
  }
}

export function nativeTaskPageForScreen(sessionId: string): TaskPageScreenTarget | null {
  const selected = browserWebContentsRegistry.browsersOfSession(sessionId)[0];
  return selected ? new NativeTaskPageScreen(selected.webContents) : null;
}
