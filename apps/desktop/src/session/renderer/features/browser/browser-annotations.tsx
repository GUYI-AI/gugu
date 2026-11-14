import { MessageSquare, X } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { BrowserAnnotationInspection, BrowserAnnotationQuery, BrowserAnnotationTarget } from '@shared/browser-annotation';
import { browserAnnotationSpaceChannel } from '@shared/events/browserEvents';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { rendererLogger } from '@/lib/log';
import { sessionAnnotations } from '../sessions/annotations/session-annotations';
import { markedAnnotationScreenshot } from './annotation-screenshot';

const log = rendererLogger('browser/annotations');
export type InspectAnnotation = (query: BrowserAnnotationQuery, capture: boolean) => Promise<BrowserAnnotationInspection>;
type Point = { x: number; y: number };

export function useBrowserAnnotations({ sessionId, browserId, visible, available, inspect }: {
  sessionId: string | undefined; browserId: string; visible: boolean; available: boolean; inspect: InspectAnnotation;
}) {
  const [active, setActive] = useState(false);
  const exit = useCallback(() => setActive(false), []);
  const { translate } = useSessionMessages();
  return {
    toolbar: sessionId && available ? <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0"
      aria-label={translate(active ? 'annotations.exit' : 'annotations.annotate')} aria-pressed={active} title={translate('annotations.annotate')}
      onClick={() => setActive(!active)}><MessageSquare className="size-4" /></Button> : null,
    overlay: active && visible && sessionId ? <BrowserAnnotationOverlay key={browserId} sessionId={sessionId} browserId={browserId}
      inspect={inspect} onExit={exit} /> : null,
  };
}

const BrowserAnnotationOverlay = observer(function BrowserAnnotationOverlay({ sessionId, browserId, inspect, onExit }: {
  sessionId: string; browserId: string; inspect: InspectAnnotation; onExit: () => void;
}) {
  const { translate } = useSessionMessages();
  const draft = sessionAnnotations.forSession(sessionId);
  const root = useRef<HTMLDivElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const [hover, setHover] = useState<BrowserAnnotationTarget | null>(null);
  const [selection, setSelection] = useState<BrowserAnnotationInspection | null>(null);
  const [drag, setDrag] = useState<BrowserAnnotationQuery | null>(null);
  const start = useRef<Point | null>(null);
  const request = useRef(0);
  const lastHover = useRef(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState<BrowserAnnotationTarget | null>(null);
  const enteredAtSubmission = useRef(draft.submissionVersion);
  useEffect(() => { if (draft.submissionVersion !== enteredAtSubmission.current) onExit(); }, [draft.submissionVersion, onExit]);

  useEffect(() => {
    const win = root.current?.ownerDocument.defaultView;
    if (!win) return;
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('textarea,input,[contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); setBrowsing(true); setHover(null); setPage(null); }
      if (event.key === 'Escape') { if (selection) setSelection(null); else onExit(); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setBrowsing(false); };
    const blur = () => setBrowsing(false);
    const stop = events.on(browserAnnotationSpaceChannel, event => {
      if (event.browserId !== browserId || event.pressed) return;
      setBrowsing(false);
      void rpc.browser.focusHost(win.name ?? '');
    });
    win.addEventListener('keydown', down); win.addEventListener('keyup', up); win.addEventListener('blur', blur);
    return () => { request.current++; stop(); win.removeEventListener('keydown', down); win.removeEventListener('keyup', up); win.removeEventListener('blur', blur); };
  }, [browserId, selection, onExit]);

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(0.999999, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(0.999999, (event.clientY - box.top) / box.height)) };
  };
  const region = (a: Point, b: Point): BrowserAnnotationQuery => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  const fail = (error: unknown) => { setError(true); log.error({ error, browserId }, 'Could not inspect the selected page'); };
  const select = async (query: BrowserAnnotationQuery) => {
    const own = ++request.current;
    setBusy(true); setError(false); setHover(null);
    try {
      const result = await inspect(query, true);
      if (own !== request.current) return;
      if (!result.screenshot) throw new Error('The selected page has no screenshot');
      setSelection(result); setPage(result.target); setText('');
    } catch (error) { if (own === request.current) fail(error); }
    finally { if (own === request.current) setBusy(false); }
  };
  const save = async () => {
    if (!selection?.screenshot || !text.trim() || busy) return;
    setBusy(true);
    try {
      const number = draft.reserveNumber();
      const screenshot = await markedAnnotationScreenshot(selection.screenshot, selection.target, number);
      draft.add({ kind: 'browser', browserId, ...selection.target, annotation: text, screenshot }, number);
      setSelection(null); setText('');
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const target = selection?.target ?? hover;
  const box = (target: BrowserAnnotationTarget) => ({ left: `${target.rect.x / target.viewport.width * 100}%`, top: `${target.rect.y / target.viewport.height * 100}%`,
    width: `${target.rect.width / target.viewport.width * 100}%`, height: `${target.rect.height / target.viewport.height * 100}%` });
  return <>
    {!browsing && <div ref={root} data-occludes-browser-page data-browser-annotation-layer className="absolute inset-0 z-10 touch-none cursor-crosshair overflow-hidden"
      onPointerDown={event => { if (selection || busy || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); setDrag(null); setHover(null); }}
      onPointerMove={event => {
        if (selection || busy) return;
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
        if (!from || selection || busy) return;
        const query = region(from, point(event));
        const size = event.currentTarget.getBoundingClientRect();
        setDrag(null);
        void select(query.width * size.width > 4 || query.height * size.height > 4 ? query : { ...from, width: 0, height: 0 });
      }} onPointerCancel={() => { start.current = null; setDrag(null); }}>
      {draft.items.filter(item => item.kind === 'browser' && item.browserId === browserId && item.url === page?.url && item.viewport.scrollX === page.viewport.scrollX && item.viewport.scrollY === page.viewport.scrollY).map(item => item.kind === 'browser' &&
        <span key={item.id} className="pointer-events-none absolute flex size-6 items-center justify-center rounded-full bg-[var(--live-light)] text-xs text-white" style={{ left: `${Math.max(0, item.rect.x / item.viewport.width * 100)}%`, top: `${Math.max(0, item.rect.y / item.viewport.height * 100)}%` }}>{item.number}</span>)}
      {target && <div className="pointer-events-none absolute border-2 border-[var(--live-light)] bg-[color-mix(in_oklab,var(--live-light)_10%,transparent)]" style={box(target)} />}
      {drag && <div className="pointer-events-none absolute border-2 border-[var(--live-light)] bg-[color-mix(in_oklab,var(--live-light)_10%,transparent)]" style={{ left: `${drag.x * 100}%`, top: `${drag.y * 100}%`, width: `${drag.width * 100}%`, height: `${drag.height * 100}%` }} />}
      {selection && <form data-browser-annotation-input className="absolute flex w-80 max-w-[calc(100%-32px)] cursor-auto flex-col gap-2 rounded-xl border border-border bg-background p-4 shadow-lift"
        style={{ left: `clamp(16px, ${selection.target.rect.x / selection.target.viewport.width * 100}%, calc(100% - 336px))`, top: `clamp(16px, ${(selection.target.rect.y + selection.target.rect.height) / selection.target.viewport.height * 100}%, calc(100% - 176px))` }}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onSubmit={event => { event.preventDefault(); void save(); }}>
        <textarea autoFocus value={text} onChange={event => setText(event.target.value)} placeholder={translate('annotations.placeholder')} aria-label={translate('annotations.comment')}
          className="min-h-16 w-full resize-none bg-transparent text-sm text-foreground outline-none" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSelection(null); } }} />
        <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setSelection(null)}>{translate('annotations.adjust')}</Button>
          <Button type="submit" size="sm" disabled={busy || !text.trim()}>{translate('annotations.comment')}</Button></div>
      </form>}
      {error && <p role="alert" className="absolute top-4 left-4 rounded-lg bg-background p-2 text-sm">{translate('annotations.failed')}</p>}
    </div>}
    {!browsing && <div data-occludes-browser-page className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-xs shadow-lift">
      <span className="whitespace-nowrap text-foreground-muted">{translate(browsing ? 'annotations.browse' : 'annotations.hint')}</span>
      <Button type="button" size="sm" disabled={!draft.canSend || busy} onClick={draft.send}>{translate('annotations.send')}</Button>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={translate('annotations.exit')} onClick={onExit}><X className="size-4" /></Button>
    </div>}
  </>;
});
