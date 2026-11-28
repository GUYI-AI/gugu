import { action, makeObservable, observable } from 'mobx';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ancestorsOf } from '@renderer/lib/layout/follow-box';
import { PANEL_REST, panelRest } from '@renderer/lib/layout/panel-track';

// ── Sink ──────────────────────────────────────────────────────────────────────

/** Receives pixel dimensions from the ResizeObserver. PaneStore satisfies this structurally. */
export interface PaneDimensionSink {
  readonly dimensions: { width: number; height: number } | null;
  setDimensions(width: number, height: number): void;
}

/** 任务浮层定位或显示期间可能出现短暂的零尺寸帧。 */
export function isUsablePaneDimensions(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

class StandaloneSink implements PaneDimensionSink {
  dimensions: { width: number; height: number } | null = null;

  constructor() {
    makeObservable(this, { dimensions: observable, setDimensions: action });
  }

  setDimensions(width: number, height: number): void {
    this.dimensions = { width, height };
  }
}

/** Standalone observable sink for panels that have no PaneStore (e.g. the terminal drawer). */
export function createPaneDimensionSink(): PaneDimensionSink {
  return new StandaloneSink();
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface PaneDimensionsValue {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sink: PaneDimensionSink;
}

const PaneDimensionContext = createContext<PaneDimensionsValue | null>(null);

export function usePaneDimensions(): PaneDimensionsValue | null {
  return useContext(PaneDimensionContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function PaneDimensionProvider({
  sink,
  atRest = false,
  children,
}: {
  sink: PaneDimensionSink;
  /** Through a move of a panel around it the width is the one it lands at (PanelTrack's panelRest): narrow or not is decided once. */
  atRest?: boolean;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // A retained session page that is not on screen keeps the size its own layout last gave it: the area it
  // sits in changes with whatever is shown instead (an App page has no task list), and measuring that would
  // resize this page's terminals for a layout nobody sees. It measures again the moment it is shown.
  const shown = useContext(SurfaceShownContext);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !shown) return;

    const commitMeasurement = (width: number, height: number) => {
      // 任务帧定位期间父级可能短暂变成 0×0，此时不能把运行中的 TUI 压到 1×2
      // 或其他被限制的最小网格；等面板恢复真实尺寸前，保留上一次有效网格。
      if (!isUsablePaneDimensions(width, height)) return;
      const previous = sink.dimensions;
      if (previous?.width === width && previous.height === height) return;
      sink.setDimensions(width, height);
    };

    const places = atRest ? ancestorsOf(el).filter((node): node is HTMLElement => node instanceof HTMLElement && node.matches('[data-panel-slot], [data-panel-fill]')) : [];
    const toCome = () => { // how much wider the rows moving around it will leave it when they land (null: none is moving)
      const moving = places.filter((place) => panelRest.get(place));
      return moving.length ? moving.reduce((sum, place) => sum + Number(panelRest.get(place)!.split(' ')[1]), 0) : null;
    };
    let last = { width: 0, height: 0 };
    const measure = () => {
      last = el.getBoundingClientRect();
      commitMeasurement(last.width + (toCome() ?? 0), last.height);
    };
    const observer = new ResizeObserver(() => { if (toCome() === null) measure(); });
    observer.observe(el);
    const told = () => { const grow = toCome(); if (grow !== null) commitMeasurement(last.width + grow, last.height); }; // a move starting: the resting size from what was last measured, ❌ measured again in the task that started it; landing changes nothing
    for (const place of places) place.addEventListener(PANEL_REST, told);

    // 初次测量发生在子组件 passive effect 之前；额外等待两帧，覆盖 provider 挂载后
    // 父级 layout effect 才为固定任务帧设置最终尺寸的情况。
    measure();
    let settleFrame: number | null = null;
    const settle = () => {
      settleFrame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(() => {
          settleFrame = null;
          measure();
        });
      });
    };
    if (typeof requestAnimationFrame === 'function') settle();

    return () => {
      observer.disconnect();
      for (const place of places) place.removeEventListener(PANEL_REST, told);
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
    };
  }, [sink, shown, atRest]);

  return (
    <PaneDimensionContext.Provider value={{ containerRef, sink }}>
      <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col">
        {children}
      </div>
    </PaneDimensionContext.Provider>
  );
}
