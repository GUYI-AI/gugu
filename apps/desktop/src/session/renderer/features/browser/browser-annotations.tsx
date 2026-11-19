import { Eye, EyeOff, MessageSquare, Trash2, X } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { annotationConversationKey, type AnnotationConversation, type BrowserAnnotationInspection, type BrowserAnnotationQuery, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import { browserAnnotationSpaceChannel } from '@shared/events/browserEvents';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { rendererLogger } from '@/lib/log';
import { useAuth } from '@/store/auth';
import { AnnotationEditor, AnnotationMarker } from '../sessions/annotations/annotation-editor';
import { sessionAnnotations } from '../sessions/annotations/session-annotations';
import { markedAnnotationScreenshot } from './annotation-screenshot';

const log = rendererLogger('browser/annotations');
export type InspectAnnotation = (query: BrowserAnnotationQuery, capture: boolean) => Promise<BrowserAnnotationInspection>;
type Point = { x: number; y: number };
type SubscribeSpaceRelease = (released: () => void) => () => void;

export function useBrowserAnnotations({ conversation, browserId, visible, available, inspect, filePath, subscribeSpaceRelease }: {
  conversation: AnnotationConversation | undefined; browserId: string; visible: boolean; available: boolean; inspect: InspectAnnotation;
  filePath?: string; subscribeSpaceRelease?: SubscribeSpaceRelease;
}) {
  const [active, setActive] = useState(false);
  const exit = useCallback(() => setActive(false), []);
  const { translate } = useSessionMessages();
  return {
    toolbar: <Button type="button" variant="ghost" size="sm" disabled={!conversation || !available} className="h-7 shrink-0 gap-2 px-2 aria-pressed:bg-[color-mix(in_oklab,var(--live-light)_16%,transparent)] aria-pressed:text-[var(--live-light)]"
      aria-pressed={active} title={active ? `${translate('annotations.hint')}: ${translate('annotations.browse')}` : translate('annotations.annotate')}
      onClick={() => setActive(!active)}><MessageSquare className="size-3.5" />{translate('annotations.mode')}</Button>,
    overlay: active && visible && available && conversation ? <BrowserAnnotationOverlay key={`${browserId}:${annotationConversationKey(conversation)}`} conversation={conversation} browserId={browserId}
      inspect={inspect} onExit={exit} filePath={filePath} subscribeSpaceRelease={subscribeSpaceRelease} /> : null,
  };
}

const BrowserAnnotationOverlay = observer(function BrowserAnnotationOverlay({ conversation, browserId, inspect, onExit, filePath, subscribeSpaceRelease }: {
  conversation: AnnotationConversation; browserId: string; inspect: InspectAnnotation; onExit: () => void;
  filePath?: string; subscribeSpaceRelease?: SubscribeSpaceRelease;
}) {
  const { translate } = useSessionMessages();
  const { user } = useAuth();
  const draft = sessionAnnotations.forConversation(conversation, user?.id);
  const root = useRef<HTMLDivElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const [hover, setHover] = useState<BrowserAnnotationTarget | null>(null);
  const [selection, setSelection] = useState<BrowserAnnotationInspection | null>(null);
  const [drag, setDrag] = useState<BrowserAnnotationQuery | null>(null);
  const start = useRef<Point | null>(null);
  const request = useRef(0);
  const lastHover = useRef(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [markersHidden, setMarkersHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState<BrowserAnnotationTarget | null>(null);
  const browserItems = draft.items.filter(item => item.kind === 'browser');
  const editing = editingId ? browserItems.find(item => item.id === editingId) : undefined;
  const editorTarget = editing ?? selection?.target;
  const editorOpen = Boolean(editorTarget);
  const closeEditor = () => {
    setSelection(null);
    setEditingId(null);
    root.current?.focus({ preventScroll: true });
  };
  const enteredAtSubmission = useRef(draft.submissionVersion);
  useEffect(() => { if (draft.submissionVersion !== enteredAtSubmission.current) onExit(); }, [draft.submissionVersion, onExit]);
  useEffect(() => { if (!browsing) root.current?.focus({ preventScroll: true }); }, [browsing]);

  // @@@effect-flow - A held Space interaction arms native focus before exposing the page; it does not read stored state.
  useEffect(() => {
    const win = root.current?.ownerDocument.defaultView;
    if (!win) return;
    let held = false;
    let browseRequest = 0;
    // HTML previews are iframes in this WebContents, so only native browser
    // views need to retain the host's keyboard focus during a page click.
    const setBrowseFocus = (browsing: boolean) => subscribeSpaceRelease ? Promise.resolve({ success: true }) :
      rpc.browser.setAnnotationBrowsing({ browserId, browsing });
    const stopBrowsing = () => {
      held = false; browseRequest++;
      setBrowsing(false);
      void setBrowseFocus(false).catch(error => {
        log.error({ error, browserId }, 'Could not release annotation browsing focus');
      });
    };
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('textarea,input,[contenteditable="true"]')) return;
      if (event.code === 'Space' && !editorOpen && !busyRef.current && !(event.target instanceof Element && event.target.closest('button'))) {
        event.preventDefault();
        if (held) return;
        held = true;
        const own = ++browseRequest;
        // Arm native click handling before exposing the page. A quick release or
        // unmount must not let a late RPC response re-enter temporary browsing.
        void setBrowseFocus(true).then(({ success }) => {
          if (!held || own !== browseRequest) return;
          if (!success) { stopBrowsing(); setError(true); return; }
          setBrowsing(true); setHover(null); setPage(null);
        }, error => {
          if (!held || own !== browseRequest) return;
          stopBrowsing(); setError(true);
          log.error({ error, browserId }, 'Could not retain annotation browsing focus');
        });
      }
      if (event.key === 'Escape') { if (editorOpen) { setSelection(null); setEditingId(null); } else onExit(); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') stopBrowsing(); };
    const blur = () => stopBrowsing();
    const stopPreview = subscribeSpaceRelease?.(() => {
      // A host element can look focused while Chromium still routes keys to the iframe.
      // Return to the host frame before focusing the rebuilt annotation canvas.
      win.focus();
      stopBrowsing();
      win.requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
    });
    const stop = events.on(browserAnnotationSpaceChannel, event => {
      if (event.browserId !== browserId || event.pressed) return;
      stopBrowsing();
      void rpc.browser.focusHost(win.name ?? '').then(() => {
        win.requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
      });
    });
    win.addEventListener('keydown', down); win.addEventListener('keyup', up); win.addEventListener('blur', blur);
    return () => { request.current++; stopBrowsing(); stop(); stopPreview?.(); win.removeEventListener('keydown', down); win.removeEventListener('keyup', up); win.removeEventListener('blur', blur); };
  }, [browserId, editorOpen, onExit, subscribeSpaceRelease]);

  // Focusing the annotation surface resolves the visible page before any pointer move.
  const readViewport = () => {
    if (busyRef.current) return;
    const own = ++request.current;
    void inspect({ x: 0.5, y: 0.5, width: 0, height: 0 }, false).then(result => {
      if (request.current === own) setPage(result.target);
    }, () => {});
  };

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(0.999999, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(0.999999, (event.clientY - box.top) / box.height)) };
  };
  const region = (a: Point, b: Point): BrowserAnnotationQuery => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  const fail = (error: unknown) => { setError(true); log.error({ error, browserId }, 'Could not inspect the selected page'); };
  const select = async (query: BrowserAnnotationQuery) => {
    const own = ++request.current;
    busyRef.current = true;
    setBusy(true); setError(false); setHover(null);
    try {
      const result = await inspect(query, true);
      if (own !== request.current) return;
      if (!result.screenshot) throw new Error('The selected page has no screenshot');
      setSelection(result); setPage(result.target);
    } catch (error) { if (own === request.current) fail(error); }
    finally {
      busyRef.current = false;
      if (own === request.current) setBusy(false);
    }
  };
  const save = async (text: string) => {
    if (busy) return;
    if (editing) {
      draft.update(editing.id, text);
      closeEditor();
      return;
    }
    if (!selection?.screenshot) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const number = draft.reserveNumber();
      const screenshot = await markedAnnotationScreenshot(selection.screenshot, selection.target, number);
      draft.add({ kind: 'browser', browserId, ...selection.target, annotation: text, screenshot, ...(filePath ? { filePath } : {}) }, number);
      closeEditor();
    } catch (error) { fail(error); } finally { busyRef.current = false; setBusy(false); }
  };
  const target = editorTarget ?? hover;
  const box = (target: BrowserAnnotationTarget) => ({ left: `${target.rect.x / target.viewport.width * 100}%`, top: `${target.rect.y / target.viewport.height * 100}%`,
    width: `${target.rect.width / target.viewport.width * 100}%`, height: `${target.rect.height / target.viewport.height * 100}%` });
  return <>
    {!browsing && <div ref={root} tabIndex={-1} data-occludes-browser-page data-browser-annotation-layer className="absolute inset-0 z-10 touch-none cursor-crosshair overflow-hidden outline-none"
      onFocus={event => { if (event.target === event.currentTarget) readViewport(); }}
      onPointerDown={event => { if (editorOpen || busy || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); setDrag(null); setHover(null); }}
      onPointerMove={event => {
        if (editorOpen || busy) return;
        const at = point(event);
        if (start.current) { setDrag(region(start.current, at)); return; }
        if (event.timeStamp - lastHover.current < 60) return;
        lastHover.current = event.timeStamp;
        const own = ++request.current;
        void inspect({ ...at, width: 0, height: 0 }, false).then(result => {
          if (own === request.current) { setHover(result.target); setPage(result.target); }
        }, () => { if (own === request.current) setHover(null); });
      }}
      onPointerUp={event => {
        const from = start.current; start.current = null;
        if (!from || editorOpen || busy) return;
        const query = region(from, point(event));
        const size = event.currentTarget.getBoundingClientRect();
        setDrag(null);
        void select(query.width * size.width > 4 || query.height * size.height > 4 ? query : { ...from, width: 0, height: 0 });
      }} onPointerCancel={() => { start.current = null; setDrag(null); }}>
      {!markersHidden && browserItems.filter(item => item.browserId === browserId && item.url === page?.url && item.viewport.scrollX === page.viewport.scrollX && item.viewport.scrollY === page.viewport.scrollY).map(item =>
        <AnnotationMarker key={item.id} number={item.number} className="absolute z-[1]"
          style={{ left: `clamp(0px, ${item.rect.x / item.viewport.width * 100}%, calc(100% - 24px))`, top: `clamp(0px, ${item.rect.y / item.viewport.height * 100}%, calc(100% - 24px))` }}
          onClick={() => { if (!busy) { setHover(null); setSelection(null); setEditingId(item.id); } }} />)}
      {target && <div className="pointer-events-none absolute border-2 border-[var(--live-light)] bg-[color-mix(in_oklab,var(--live-light)_10%,transparent)]" style={box(target)} />}
      {drag && <div className="pointer-events-none absolute border-2 border-[var(--live-light)] bg-[color-mix(in_oklab,var(--live-light)_10%,transparent)]" style={{ left: `${drag.x * 100}%`, top: `${drag.y * 100}%`, width: `${drag.width * 100}%`, height: `${drag.height * 100}%` }} />}
      {editorTarget && <div data-browser-annotation-input className="absolute z-[2] w-80 max-w-[calc(100%_-_16px)]"
        style={{ left: `clamp(8px, ${editorTarget.rect.x / editorTarget.viewport.width * 100}%, max(8px, calc(100% - 328px)))`,
          top: `clamp(8px, ${editorTarget.rect.y / editorTarget.viewport.height * 100}% - 48px, calc(100% - 48px))` }}>
        <AnnotationEditor key={editing?.id ?? 'new'} number={editing?.number ?? draft.nextAnnotationNumber} initialValue={editing?.annotation}
          busy={busy} onSave={value => void save(value)} onCancel={closeEditor}
          onRemove={editing ? () => { draft.remove(editing.id); closeEditor(); } : undefined} />
      </div>}
      {!editorTarget && !draft.items.length && <div className="pointer-events-none absolute top-2 left-4 max-w-80 rounded-xl bg-foreground px-4 py-2 text-center text-xs text-background">
        {translate('annotations.hint')}  {translate('annotations.browse')}
      </div>}
      {error && <p role="alert" className="absolute top-4 left-4 rounded-lg bg-background p-2 text-sm">{translate('annotations.failed')}</p>}
    </div>}
    {!browsing && draft.items.length > 0 && <div data-browser-annotation-controls data-occludes-browser-page className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%_-_32px)] -translate-x-1/2 items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-xs text-background shadow-lift">
      <span className="min-w-0 truncate">{translate('annotations.active', { count: draft.items.length })}</span>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-background hover:text-background" aria-pressed={markersHidden}
        aria-label={translate(markersHidden ? 'annotations.showMarkers' : 'annotations.hideMarkers')} title={translate(markersHidden ? 'annotations.showMarkers' : 'annotations.hideMarkers')}
        onClick={() => setMarkersHidden(!markersHidden)}>{markersHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-background hover:text-background" disabled={busy}
        aria-label={translate('annotations.deleteAll')} title={translate('annotations.deleteAll')} onClick={() => { draft.clear(); closeEditor(); }}><Trash2 className="size-4" /></Button>
      <Button type="button" size="sm" className="rounded-full bg-[var(--live-light)] text-[var(--color-white)] hover:bg-[var(--live-light)]" disabled={!draft.canSend || busy} onClick={draft.send}>{translate('annotations.send')}</Button>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-background hover:text-background" aria-label={translate('annotations.exit')} onClick={onExit}><X className="size-4" /></Button>
    </div>}
  </>;
});
