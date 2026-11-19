import { useEffect, useMemo, useRef } from 'react';
import { useSelect } from '@/lib/selectStore';
import { messageForUser } from '@/lib/userFacingError';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { BrowserPageHandle } from './browser-page-handle';
import { BrowserPictureFrame } from './browser-picture-frame';
import { createStandaloneSurfaceState, mountStandaloneBrowserSurface } from './standalone-browser-surface-lifetime';

/** The normal tab toolbar stays intact; its page uses the shared picture/input stream. */
export function StandaloneBrowserPageSurface({ browserId, partition, initialUrl, visible, onHandle }: {
  browserId: string; partition: string; initialUrl: string; visible: boolean;
  onHandle(handle: BrowserPageHandle | null): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const initial = useRef(initialUrl);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lifetime = useRef<ReturnType<typeof mountStandaloneBrowserSurface> | null>(null);
  const changes = useMemo(() => createStandaloneSurfaceState(), [browserId, partition]);
  const view = useSelect(changes, value => value);
  const { translate } = useSessionMessages();

  useEffect(() => {
    if (!viewport.current || !root.current) return;
    const current = mountStandaloneBrowserSurface({ browserId, partition, initialUrl: initial.current,
      visible: visibleRef.current, viewport: viewport.current, picture: root.current, changes,
      onHandle: handle => onHandleRef.current(handle) });
    lifetime.current = current;
    return () => { current.close(); if (lifetime.current === current) lifetime.current = null; };
  }, [browserId, partition, changes]);
  useEffect(() => { lifetime.current?.setVisible(visible); }, [visible]);

  return <div ref={viewport} className="absolute inset-0 overflow-hidden bg-background"
    onPointerDown={() => { void rpc.browser.setActiveBrowser(browserId); }}>
    <BrowserPictureFrame viewport={view.viewport} frame={view.frame}><div ref={root} className="absolute inset-0" /></BrowserPictureFrame>
    {(view.error != null || view.state !== 'live' && view.state !== 'input-paused') && <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-sm text-foreground-muted">
      {view.error != null ? messageForUser(view.error) : translate(view.state === 'closed' ? 'browser.sessionUnavailable' : 'browser.preparingSession')}
    </div>}
  </div>;
}
