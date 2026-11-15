import { webContents, type WebContents } from 'electron';
import type { ResourcePageMetrics } from '@shared/resource-monitor';
import type { RendererMetrics } from '@shared/renderer-metrics';

/**
 * Main-window page metrics for the resource monitor. Two cumulative sources, differenced against the last recorded
 * sample only (`commitPageTotals`), so an extra read (the page asking for a snapshot) never splits an
 * interval out of the history:
 * - frame counters the main window keeps itself (long animation frames, slow interactions — src/lib/frameCounters.ts);
 * - Blink's own style/layout counters through the window's debugger (`Performance.getMetrics`), no port opened.
 *   Measured on macOS (11-07): on a whole-page restyle workload the cost stayed inside the ±1% resolution of the
 *   measurement; idle it was ~2 M instructions per 45 s. Still switchable off in settings.
 */
const PROTOCOL_VERSION = '1.3';
const COUNTERS = ['RecalcStyleDuration', 'LayoutDuration', 'RecalcStyleCount', 'LayoutCount', 'Nodes', 'JSEventListeners'] as const;
type Counter = (typeof COUNTERS)[number];

export interface PageTotals {
  at: number;
  /** Which renderer processes / windows these totals belong to; a change (reload, crash, new window) restarts the baseline. */
  frameKey: string;
  counterKey?: string;
  longFrames: number;
  blockingMs: number;
  slowInteractions: number;
  counters?: Record<Counter, number>;
  countersUnavailable?: ResourcePageMetrics['countersUnavailable'];
}

/** Windows whose Performance domain this module enabled; `own` = this module attached the debugger and may detach it. */
const attached = new Map<number, { contents: WebContents; own: boolean }>();
let committed: PageTotals | null = null;
/** Bumped on every detach, so a read still awaiting the debugger when monitoring or the counters stop never re-attaches. */
let generation = 0;

const isMainWindow = (contents: WebContents) => !contents.isDestroyed() && contents.getType() === 'window' && contents.getURL().startsWith('gugu-app://app/');

async function attach(contents: WebContents): Promise<void> {
  if (attached.has(contents.id)) return;
  const own = !contents.debugger.isAttached();
  if (own) contents.debugger.attach(PROTOCOL_VERSION);
  // Registered before the await: a detach while Performance.enable is pending undoes it too.
  attached.set(contents.id, { contents, own });
  const forget = () => { attached.delete(contents.id); };
  contents.debugger.once('detach', forget);
  contents.once('destroyed', forget);
  await contents.debugger.sendCommand('Performance.enable', { timeDomain: 'timeTicks' });
}

function detachAll(): void {
  generation += 1;
  for (const { contents, own } of attached.values()) {
    try {
      if (contents.isDestroyed() || !contents.debugger.isAttached()) continue;
      // Someone else's debugger (DevTools, another module) stays attached; only the domain this module enabled goes.
      if (own) contents.debugger.detach();
      else void contents.debugger.sendCommand('Performance.disable').catch(() => {});
    } catch { /* already gone */ }
  }
  attached.clear();
}

/** Monitoring stopped: detach from every window and forget the baseline. */
export function stopPageCounters(): void {
  detachAll();
  committed = null;
}

async function readCounters(): Promise<Pick<PageTotals, 'counters' | 'counterKey' | 'countersUnavailable'>> {
  const windows = webContents.getAllWebContents().filter(isMainWindow);
  if (!windows.length) return { countersUnavailable: 'no-window' };
  const started = generation;
  try {
    const sum = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<Counter, number>;
    for (const contents of windows) {
      if (started !== generation) return { countersUnavailable: 'off' };
      await attach(contents);
      if (started !== generation) return { countersUnavailable: 'off' };
      const { metrics } = await contents.debugger.sendCommand('Performance.getMetrics') as { metrics: { name: string; value: number }[] };
      for (const { name, value } of metrics) if ((COUNTERS as readonly string[]).includes(name)) sum[name as Counter] += value;
    }
    return { counters: sum, counterKey: windows.map((w) => `${w.id}:${w.getOSProcessId()}`).sort().join(',') };
  } catch {
    return { countersUnavailable: started === generation ? 'failed' : 'off' };
  }
}

export async function readPageTotals(renderers: RendererMetrics[], countersOn: boolean): Promise<PageTotals> {
  const main = renderers.filter((r) => r.source === 'main-window' && r.frames);
  const frames = { longFrames: 0, blockingMs: 0, slowInteractions: 0 };
  for (const r of main) for (const key of ['longFrames', 'blockingMs', 'slowInteractions'] as const) frames[key] += r.frames![key];
  // Counters switched off: detach, but keep differencing the frame counters against the recorded baseline.
  if (!countersOn) detachAll();
  return {
    at: Date.now(),
    frameKey: main.map((r) => r.pid).sort().join(','),
    ...frames,
    ...(countersOn ? await readCounters() : { countersUnavailable: 'off' as const }),
  };
}

/** The delta from the last recorded sample; undefined until there is one to difference against. */
export function pageMetricsSince(totals: PageTotals): ResourcePageMetrics | undefined {
  const base = committed;
  if (!base || base.frameKey !== totals.frameKey || !totals.frameKey) return undefined;
  const page: ResourcePageMetrics = {
    intervalMs: totals.at - base.at,
    longFrames: totals.longFrames - base.longFrames,
    blockingMs: totals.blockingMs - base.blockingMs,
    slowInteractions: totals.slowInteractions - base.slowInteractions,
  };
  if (totals.counters && base.counters && base.counterKey === totals.counterKey) {
    const d = (key: Counter) => totals.counters![key] - base.counters![key];
    page.styleLayoutMs = Math.round((d('RecalcStyleDuration') + d('LayoutDuration')) * 10_000) / 10;
    page.styleRecalcs = d('RecalcStyleCount');
    page.layouts = d('LayoutCount');
  }
  if (totals.counters) { page.nodes = totals.counters.Nodes; page.listeners = totals.counters.JSEventListeners; }
  if (totals.countersUnavailable) page.countersUnavailable = totals.countersUnavailable;
  return page;
}

export function commitPageTotals(totals: PageTotals): void { committed = totals; }
