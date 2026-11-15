import { mountProjection } from '@/session/app-runtime/projection-view';
import type { LiveWindowResourceDescriptor } from '@shared/extensions/live-window-protocol';
import type { LiveWindowContext, LiveWindowSource } from './types';
import type { LiveWindowTransport } from './transport';
import { LiveWindowModel } from './model';

type Picture = {
  descriptor: LiveWindowResourceDescriptor;
  source: LiveWindowSource;
  element: HTMLDivElement;
  present: boolean;
  epoch: number;
  view: Awaited<ReturnType<typeof mountProjection>> | null;
  opening: Promise<void> | null;
  frozenView: Awaited<ReturnType<typeof mountProjection>> | null;
};
export class LiveWindowConversation {
  readonly model: LiveWindowModel;
  private pictures = new Map<string, Picture>();
  private context: LiveWindowContext;
  private operating = false;
  private visible = new Set<string>();
  private generation = 0;
  private offSources: (() => void) | null = null;
  private observing = false;
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private disposed = false;
  private offModel: () => void;
  private cleanups = new Set<() => void>();

  constructor(context: LiveWindowContext, platform: 'desktop' | 'phone', private transport: LiveWindowTransport, private report: (error: unknown) => void) {
    this.context = { ...context, shown: false };
    this.model = new LiveWindowModel(platform); this.model.activate(this.context);
    this.offModel = this.model.subscribe(() => this.inputState());
  }
  getContext() { return this.context; }
  addCleanup(cleanup: () => void): void { if (this.disposed) cleanup(); else this.cleanups.add(cleanup); }
  picture(id: string): HTMLElement | null { return this.pictures.get(id)?.element ?? null; }
  setOperating(value: boolean): void {
    if (this.operating === value || this.disposed) return;
    this.operating = value;
    this.publish();
    if (value && this.context.shown) { void this.refresh(); this.startPictures(); }
    else for (const picture of this.pictures.values()) this.freeze(picture);
  }
  setVisible(holder: string, shown: boolean): void {
    if (this.disposed) return;
    if (shown) this.visible.add(holder); else this.visible.delete(holder);
    const next = this.visible.size > 0 && this.context.privateAgentChat;
    if (next === this.context.shown) return;
    this.context = { ...this.context, shown: next }; this.model.activate(this.context);
    if (next) {
      this.startObservation();
      this.startPictures();
    } else {
      this.generation++; this.offSources?.(); this.offSources = null; this.observing = false;
      for (const picture of this.pictures.values()) this.freeze(picture);
    }
  }
  private startObservation(): void {
    if (this.offSources || this.observing || this.disposed) return;
    const generation = this.generation;
    this.observing = true;
    void this.transport.observe(this.context.sessionId, () => { void this.refresh(); }).then(off => {
      if (this.disposed || generation !== this.generation || !this.context.shown) { off(); return; }
      this.offSources = off; this.observing = false; void this.refresh();
    }, error => { if (generation === this.generation && !this.disposed) { this.observing = false; this.report(error); } });
  }
  refresh(): Promise<void> {
    if (this.disposed || !this.context.shown || !this.context.privateAgentChat) return Promise.resolve();
    if (this.reading) { this.readAgain = true; return this.reading; }
    const generation = this.generation;
    this.reading = (async () => {
      do {
        this.readAgain = false;
        const descriptors = await this.transport.list(this.context.sessionId);
        if (this.disposed || generation !== this.generation || !this.context.shown) return;
        const selected = descriptors.filter(source => source.type === 'task-page'
          || source.type === 'app-projection' && source.appId === 'computer-use');
        for (const picture of this.pictures.values()) picture.present = false;
        for (const descriptor of selected) {
          let picture = this.pictures.get(descriptor.id);
          if (!picture) {
            const element = document.createElement('div'); element.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';
            element.dataset.liveWindowPicture = descriptor.id;
            picture = { descriptor, source: { id: descriptor.id, kind: descriptor.type === 'task-page' ? 'browser' : 'computer',
              deviceId: this.context.deviceId, sessionId: this.context.sessionId, agentId: this.context.agentId,
              title: descriptor.title, size: descriptor.size, status: 'finished' },
              element, present: true, epoch: 0, view: null, opening: null, frozenView: null };
            this.pictures.set(descriptor.id, picture);
          }
          picture.present = true; picture.descriptor = descriptor;
          picture.source = { ...picture.source, title: descriptor.title, size: descriptor.size ?? picture.source.size };
        }
        this.publish();
        this.startPictures();
        for (const picture of this.pictures.values()) if (!picture.present) this.freeze(picture);
      } while (this.readAgain && generation === this.generation && this.context.shown);
    })().catch(error => { if (!this.disposed && generation === this.generation) this.report(error); }).finally(() => {
      this.reading = null;
      if (this.readAgain && !this.disposed && this.context.shown) void this.refresh();
    });
    return this.reading;
  }
  private publish(): void {
    const latest = new Map<LiveWindowSource['kind'], Picture>();
    for (const picture of this.pictures.values()) {
      const previous = latest.get(picture.source.kind);
      if (!previous || picture.present || !previous.present) latest.set(picture.source.kind, picture);
    }
    const sources = [...latest.values()].map(picture => {
      picture.source = { ...picture.source, status: picture.present && this.operating ? 'operating' : 'finished' };
      return picture.source;
    });
    this.model.observe(this.context, sources);
  }
  private startPictures(): void {
    if (!this.context.shown || !this.operating || this.disposed || this.model.getSnapshot().presentation?.mode === 'closed') return;
    const displayed = new Set(this.model.getSnapshot().sources.map(source => source.id));
    for (const picture of this.pictures.values()) {
      if (!picture.present || !displayed.has(picture.source.id) || picture.view || picture.opening) continue;
      const epoch = ++picture.epoch;
      const host = this.transport.picture(picture.descriptor, page => {
        if (this.disposed || epoch !== picture.epoch) return;
        picture.source = { ...picture.source, title: page.title }; this.publish();
      });
      picture.opening = (async () => {
        const previous = picture.frozenView; picture.frozenView = null;
        if (previous) await previous.close();
        const view = await mountProjection(host, picture.element, picture.descriptor.id, {
          interactive: false,
          painted: frame => {
            if (frame && !this.disposed && epoch === picture.epoch) {
              picture.source = { ...picture.source, size: { width: frame.width, height: frame.height } };
              this.publish();
            }
          },
          error: error => { if (!this.disposed && epoch === picture.epoch) this.report(error); },
        });
        if (this.disposed) { await view.close(); return; }
        if (epoch !== picture.epoch || !this.context.shown || !this.operating) { picture.frozenView = view; await view.freeze(); return; }
        picture.view = view; this.inputState();
      })().catch(error => { if (!this.disposed && epoch === picture.epoch) this.report(error); }).finally(() => { picture.opening = null;
        if (!this.disposed && this.context.shown && this.operating && picture.present && epoch !== picture.epoch) this.startPictures();
      });
    }
  }
  private inputState(): void {
    const snapshot = this.model.getSnapshot(), state = snapshot.presentation;
    if (state?.mode === 'closed') {
      for (const picture of this.pictures.values()) this.freeze(picture);
      return;
    }
    this.startPictures();
    const interactive = snapshot.visible && snapshot.operating && (state?.mode === 'enlarged'
      || state?.mode === 'tabbed' && state.selectedTab === 'screen');
    for (const picture of this.pictures.values()) picture.view?.setInteractive(interactive && snapshot.source?.id === picture.source.id);
  }
  private freeze(picture: Picture): void {
    picture.epoch++;
    const view = picture.view; picture.view = null;
    if (view) {
      void view.freeze().catch(this.report);
      // Retain the decoded image. Only a later operation or disposal removes this frozen surface.
      picture.frozenView = view;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.offSources?.(); this.offSources = null; this.offModel();
    for (const cleanup of this.cleanups) cleanup(); this.cleanups.clear();
    for (const picture of this.pictures.values()) { this.freeze(picture); void picture.frozenView?.close().catch(this.report); picture.element.remove(); }
    this.pictures.clear(); this.model.clear();
  }
}
