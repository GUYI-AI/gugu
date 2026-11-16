import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { Maximize2, Minimize2, ExternalLink, X } from '@/lib/icons';
import { fitLiveWindow } from './geometry';
import type { LiveWindowAction, LiveWindowPresentation, LiveWindowSource } from './types';
import { useLiveWindowLabels } from './desktop-labels';

export function DesktopLiveWindow({ source, sources = [source], state, dispatch, children, onWidth }: {
  source: LiveWindowSource & { picture: ReactNode }; state: LiveWindowPresentation;
  sources?: readonly LiveWindowSource[];
  dispatch(action: LiveWindowAction): void; children?: ReactNode; onWidth?(width: number): void;
}) {
  const t = useLiveWindowLabels(), root = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const enlarged = state.mode === 'enlarged';
  const switchSources = enlarged && sources.some(item => item.kind === 'browser') && sources.some(item => item.kind === 'computer');
  const footerHeight = switchSources ? 32 : 0;
  const fit = fitLiveWindow(source.size, { width: enlarged ? Math.min(640, bounds.width * .55) : Math.min(240, bounds.width - 32), height: bounds.height - (enlarged ? 80 + footerHeight : 160) });
  const width = fit?.width ?? 0, height = fit?.height ?? 0;
  const left = enlarged ? bounds.width - width - 16 : state.small.x === undefined
    ? bounds.width - width - 16 : state.small.x * Math.max(0, bounds.width - width - 32) + 16;
  const top = enlarged ? 16 : state.small.y === undefined
    ? Math.max(16, bounds.height - height - 144) : state.small.y * Math.max(0, bounds.height - height - 176) + 16;
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { onWidth?.(enlarged ? width + 32 : 0); return () => onWidth?.(0); }, [enlarged, width, onWidth]);
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current; if (!start || !fit) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) < 4 && !start.moved) return;
    start.moved = true;
    dispatch({ type: 'position', small: { corner: 'bottom-right',
      x: (start.left + dx - 16) / Math.max(1, bounds.width - width - 32),
      y: (start.top + dy - 16) / Math.max(1, bounds.height - height - 176) } });
  };
  return <div ref={root} className="pointer-events-none absolute inset-0" data-live-window-layer>
    {children}
    {fit && <section data-live-window={state.mode} data-source-kind={source.kind}
      className="group pointer-events-auto absolute overflow-hidden rounded-xl border border-border bg-background-1 shadow-lg"
      style={{ left, top, width, height: height + (enlarged ? 40 + footerHeight : 0), touchAction: enlarged ? undefined : 'none' }}
      onPointerDown={event => {
        if (enlarged || (event.target as HTMLElement).closest('button')) return;
        drag.current = { x: event.clientX, y: event.clientY, left, top, moved: false }; event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {enlarged && <div className="flex h-10 items-center justify-end gap-1 px-1">
        <IconButton size="sm" aria-label={t('minimize')} onClick={() => dispatch({ type: 'minimize' })}><Minimize2 /></IconButton>
        <IconButton size="sm" aria-label={t('tab')} onClick={() => dispatch({ type: 'show-tab' })}><ExternalLink /></IconButton>
      </div>}
      <div data-live-window-picture style={{ width, height, pointerEvents: enlarged && source.status === 'operating' ? 'auto' : 'none' }}>{source.picture}</div>
      {switchSources && <div role="tablist" aria-label={t('sources')} className="flex h-8 items-center justify-center gap-4 text-xs text-muted-foreground">
        {sources.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === source.id}
          className="cursor-pointer aria-selected:text-foreground" onClick={() => dispatch({ type: 'select-source', sourceId: item.id })}>{t(item.kind === 'browser' ? 'web' : 'computer')}</button>)}
      </div>}
      {!enlarged && <div className="pointer-events-none invisible absolute inset-0 opacity-0 group-hover:visible group-hover:opacity-100">
        <IconButton size="sm" aria-label={t('closeSmall')} className="pointer-events-auto absolute right-1 top-1 bg-background-1/70" onClick={() => dispatch({ type: 'close-small' })}><X /></IconButton>
        <IconButton size="lg" shape="pill" aria-label={t('enlarge')} className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background-1/80 shadow-sm" onClick={() => dispatch({ type: 'enlarge' })}><Maximize2 /></IconButton>
      </div>}
    </section>}
  </div>;
}
