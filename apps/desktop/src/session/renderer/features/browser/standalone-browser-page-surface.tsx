import { useEffect, useRef, useState } from 'react';
import { messageForUser } from '@/lib/userFacingError';
import { mountProjection, type ProjectionViewState } from '@/session/app-runtime/projection-view';
import type { ProjectionHost } from '@/session/app-runtime/projection-source';
import { events, rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { browserPageEventChannel, browserTaskPagePacketChannel } from '@shared/events/browserEvents';
import { BrowserPageHandle } from './browser-page-handle';
import { BrowserPictureFrame } from './browser-picture-frame';

/** The normal tab toolbar stays intact; only its page surface uses the shared picture/input protocol. */
export function StandaloneBrowserPageSurface({ browserId, partition, initialUrl, visible, onHandle }: {
  browserId: string; partition: string; initialUrl: string; visible: boolean;
  onHandle(handle: BrowserPageHandle | null): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const initial = useRef(initialUrl);
  const [ready, setReady] = useState(false);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [pictureSize, setPictureSize] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [state, setState] = useState<ProjectionViewState>('connecting');
  const [error, setError] = useState<unknown>(null);
  const { translate } = useSessionMessages();

  useEffect(() => {
    if (!viewport.current) return;
    let closed = false;
    const handle = new BrowserPageHandle(browserId, viewport.current);
    const off = events.on(browserPageEventChannel, event => { if (event.browserId === browserId) handle.apply(event); });
    void rpc.browser.mountPage({ browserId, partition, url: initial.current, windowName: window.name }).then(result => {
      if (closed) return;
      if (!result.success) throw new Error(result.error);
      handle.mounted(result);
      onHandleRef.current(handle);
      setReady(true);
    }).catch(failure => { if (!closed) setError(failure); });
    return () => { closed = true; off(); setReady(false); onHandleRef.current(null); };
  }, [browserId, partition]);

  useEffect(() => {
    if (!ready || !visible || !root.current) return;
    let closed = false;
    let projection: Awaited<ReturnType<typeof mountProjection>> | undefined;
    const host: ProjectionHost = {
      projection: {
        watch: async ({ watchId: id }) => { await rpc.browser.watchStandalonePage({ browserId, watchId: id }); if (!closed) setWatchId(id); },
        unwatch: ({ watchId: id }) => rpc.browser.unwatchTaskPage(id).then(() => undefined),
        send: ({ watchId: id, packet }) => rpc.browser.sendTaskPage({ watchId: id, packet }),
        create: () => Promise.reject(new Error('This browser page is already open')),
        publish: () => Promise.reject(new Error('This browser page is already open')),
        close: () => Promise.resolve(), closed: () => Promise.resolve(), inputResult: () => Promise.resolve(),
      },
      onProjection: handler => events.on(browserTaskPagePacketChannel, ({ watchId: id, packet }) => handler(id, packet)),
    };
    setState('connecting');
    void mountProjection(host, root.current, `standalone:${browserId}`, {
      decorations: true, state: value => { if (!closed) setState(value); },
      painted: value => { if (!closed) setFrame(value); },
      error: failure => { if (!closed) { setError(failure); setState('closed'); } },
    }).then(view => { if (closed) void view.close(); else projection = view; }, failure => { if (!closed) setError(failure); });
    return () => { closed = true; setWatchId(null); void projection?.close(); };
  }, [browserId, ready, visible]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      setPictureSize({ width, height });
      if (watchId && width >= 100 && height >= 100) {
        void rpc.browser.controlTaskPage({ watchId, control: { action: 'resize', width: Math.round(width), height: Math.round(height),
          scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) } }).catch(setError);
      }
    };
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(resize, 120); });
    observer.observe(element);
    resize();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [watchId]);

  return <div ref={viewport} className="absolute inset-0 overflow-hidden bg-background"
    onPointerDown={() => { void rpc.browser.setActiveBrowser(browserId); }}>
    <BrowserPictureFrame viewport={pictureSize} frame={frame}><div ref={root} className="absolute inset-0" /></BrowserPictureFrame>
    {(error != null || state !== 'live' && state !== 'input-paused') && <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-sm text-foreground-muted">
      {error != null ? messageForUser(error) : translate(state === 'closed' ? 'browser.sessionUnavailable' : 'browser.preparingSession')}
    </div>}
  </div>;
}
