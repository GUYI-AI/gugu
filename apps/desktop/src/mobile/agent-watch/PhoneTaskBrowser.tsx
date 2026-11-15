import { BrowserPictureFrame } from '@renderer/features/browser/browser-picture-frame';
import { messageForUser } from '@/lib/userFacingError';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mountProjection, type ProjectionViewState } from '@/session/app-runtime/projection-view';
import { BrowserToolbar } from '@renderer/features/browser/browser-toolbar';
import { TaskPageResource } from '@renderer/features/browser/task-page-tab';
import { useBrowserAnnotations } from '@renderer/features/browser/browser-annotations';
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TaskPageControl } from '@shared/browser-task-page';
import { phoneTaskBrowserHost } from './phone-task-browser-host';

export const PHONE_TASK_BROWSER = 'gugu:task-browser';

export const PhoneTaskBrowser = observer(function PhoneTaskBrowser({ deviceId, sessionId, onSent }: {
  deviceId: string; sessionId: string; onSent: () => void;
}) {
  const { translate } = useSessionMessages();
  const resource = useMemo(() => new TaskPageResource(deviceId, sessionId), [deviceId, sessionId]);
  const transport = useMemo(() => phoneTaskBrowserHost(deviceId, sessionId, state => resource.setPage(state)), [deviceId, sessionId, resource]);
  const visibility = useConversationVisibility(true);
  const viewport = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ProjectionViewState>('connecting');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = sessionAnnotations.forSession(sessionId);
  const submission = useRef(draft.submissionVersion);
  useEffect(() => { if (draft.submissionVersion !== submission.current) onSent(); }, [draft.submissionVersion, onSent]);
  useEffect(() => {
    if (!visibility.shown || !picture.current) return;
    setState('connecting'); setError(null);
    let view: Awaited<ReturnType<typeof mountProjection>> | null = null;
    let gone = false;
    void mountProjection(transport.host, picture.current, `${deviceId}:${sessionId}`, {
      state: next => { if (!gone) setState(next); }, painted: next => { if (!gone) setFrame(next); }, error: error => { if (!gone) setError(messageForUser(error)); },
    }).then(value => { if (gone) void value.close(); else view = value; }, error => { if (!gone) { setState('closed'); setError(messageForUser(error)); } });
    return () => { gone = true; void view?.close(); };
  }, [transport, deviceId, sessionId, visibility.shown]);
  useEffect(() => {
    if (!viewport.current) return;
    const read = () => { const box = viewport.current!.getBoundingClientRect(); setSize({ width: box.width, height: box.height }); };
    const observer = new ResizeObserver(read); observer.observe(viewport.current); read();
    return () => observer.disconnect();
  }, []);
  const control = useCallback((control: TaskPageControl) => { void transport.control(control).catch(error => setError(messageForUser(error))); }, [transport]);
  useEffect(() => {
    if (!visibility.shown || state !== 'live' || size.width < 100 || size.height < 100) return;
    const timer = setTimeout(() => control({ action: 'resize', width: Math.round(size.width), height: Math.round(size.height), scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) }), 120);
    return () => clearTimeout(timer);
  }, [state, size.width, size.height, control, visibility.shown]);
  const annotations = useBrowserAnnotations({ browserId: `task-page:${deviceId}:${sessionId}`, sessionId, visible: visibility.shown, available: visibility.shown && state === 'live',
    inspect: async (query, capture) => {
      const result = await transport.control({ action: 'annotate', query, capture });
      if (!result) throw new Error('The page selection is unavailable');
      return result;
    } });
  return <div ref={visibility.ref} data-phone-task-browser className="flex min-h-0 flex-1 flex-col bg-background">
    {resource.session && <BrowserToolbar session={resource.session} adapter={null} remote annotationAction={annotations.toolbar}
      onNavigate={url => { control({ action: 'navigate', url }); return true; }} onGoBack={() => control({ action: 'back' })}
      onGoForward={() => control({ action: 'forward' })} onReload={() => control({ action: resource.page?.isLoading ? 'stop' : 'reload' })} />}
    <div ref={viewport} data-theme="light" className="emlight relative min-h-0 flex-1 bg-background">
      <BrowserPictureFrame viewport={size} frame={frame}>
        <div ref={picture} className="absolute inset-0" />{annotations.overlay}
      </BrowserPictureFrame>
      {state === 'live' && error && <p role="alert" className="absolute bottom-4 left-4 rounded-lg bg-background p-2 text-sm">{error}</p>}
      {state !== 'live' && <div role={error ? 'alert' : 'status'} className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-foreground-muted">
        {error ?? translate(state === 'closed' ? 'browser.sessionUnavailable' : 'browser.preparingSession')}
      </div>}
    </div>
  </div>;
});
