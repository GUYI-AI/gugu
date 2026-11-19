import { createSelectStore, type SelectStore } from '@/lib/selectStore';
import { mountProjection, type ProjectionViewState } from '@/session/app-runtime/projection-view';
import type { ProjectionHost } from '@/session/app-runtime/projection-source';
import { events, rpc } from '@renderer/lib/ipc';
import { browserPageEventChannel, browserTaskPagePacketChannel } from '@shared/events/browserEvents';
import { BrowserPageHandle } from './browser-page-handle';

type Size = { width: number; height: number };
export type StandaloneSurfaceState = {
  viewport: Size; frame: Size | null; state: ProjectionViewState; error: unknown;
};

/** This is a picture/input stream lifetime, not a second cache of device settings or page metadata. */
export function createStandaloneSurfaceState() {
  return createSelectStore<StandaloneSurfaceState>({ viewport: { width: 0, height: 0 }, frame: null, state: 'connecting', error: null });
}

/** Own the mount, watch and DOM observers together, including replies that arrive after a tab was hidden/unmounted. */
export function mountStandaloneBrowserSurface(options: {
  browserId: string; partition: string; initialUrl: string; visible: boolean;
  viewport: HTMLElement; picture: HTMLElement; changes: SelectStore<StandaloneSurfaceState>;
  onHandle(handle: BrowserPageHandle | null): void;
}) {
  const { browserId, viewport, picture, changes } = options;
  const handle = new BrowserPageHandle(browserId, viewport);
  let closed = false, mounted = false, visible = options.visible;
  let generation = 0;
  let watchId: string | null = null;
  let projection: Awaited<ReturnType<typeof mountProjection>> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout>;
  const publish = (patch: Partial<StandaloneSurfaceState>) => {
    if (closed) return;
    changes.publish({ ...changes.get(), ...patch });
    changes.notify();
  };
  publish({ frame: null, state: 'connecting', error: null });
  const fail = (error: unknown) => publish({ error, state: 'closed' });
  const resize = () => {
    const { width, height } = viewport.getBoundingClientRect();
    publish({ viewport: { width, height } });
    if (watchId && width >= 100 && height >= 100) {
      void rpc.browser.controlTaskPage({ watchId, control: { action: 'resize', width: Math.round(width), height: Math.round(height),
        scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) } }).catch(fail);
    }
  };
  const stopProjection = () => {
    generation += 1;
    watchId = null;
    const previous = projection;
    projection = undefined;
    void previous?.close().catch(fail);
  };
  const showProjection = () => {
    if (!mounted || !visible || closed) return;
    const current = ++generation;
    const active = () => !closed && current === generation;
    const host: ProjectionHost = {
      projection: {
        watch: async ({ watchId: id }) => {
          await rpc.browser.watchStandalonePage({ browserId, watchId: id });
          if (active()) { watchId = id; resize(); }
        },
        unwatch: ({ watchId: id }) => rpc.browser.unwatchTaskPage(id).then(() => undefined),
        send: ({ watchId: id, packet }) => rpc.browser.sendTaskPage({ watchId: id, packet }),
        create: () => Promise.reject(new Error('This browser page is already open')),
        publish: () => Promise.reject(new Error('This browser page is already open')),
        close: () => Promise.resolve(), closed: () => Promise.resolve(), inputResult: () => Promise.resolve(),
      },
      onProjection: listener => events.on(browserTaskPagePacketChannel, ({ watchId: id, packet }) => listener(id, packet)),
    };
    publish({ state: 'connecting', error: null });
    void mountProjection(host, picture, `standalone:${browserId}`, {
      decorations: true,
      state: state => { if (active()) publish({ state }); },
      painted: frame => { if (active()) publish({ frame }); },
      error: error => { if (active()) fail(error); },
    }).then(view => {
      if (!active()) void view.close().catch(fail);
      else projection = view;
    }, error => { if (active()) fail(error); });
  };
  const off = events.on(browserPageEventChannel, event => { if (event.browserId === browserId) handle.apply(event); });
  const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
  observer.observe(viewport);
  resize();
  void rpc.browser.mountPage({ browserId, partition: options.partition, url: options.initialUrl, windowName: window.name }).then(result => {
    if (closed) return;
    if (!result.success) throw new Error(result.error);
    handle.mounted(result);
    mounted = true;
    options.onHandle(handle);
    showProjection();
  }).catch(fail);
  return {
    setVisible(next: boolean) {
      if (closed || visible === next) return;
      visible = next;
      stopProjection();
      if (visible) showProjection();
    },
    close() {
      if (closed) return;
      closed = true;
      stopProjection();
      observer.disconnect();
      clearTimeout(resizeTimer);
      off();
      options.onHandle(null);
    },
  };
}
