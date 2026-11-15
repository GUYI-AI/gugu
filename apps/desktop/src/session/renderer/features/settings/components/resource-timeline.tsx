import { messageForUser } from '@/lib/userFacingError';
import { formatClock } from '@/i18n/format';
import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { formatBytes } from '@renderer/utils/formatBytes';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ResourceCapture, ResourceHistory, ResourcePoint, ResourceSnapshot } from '@shared/resource-monitor';
import { publicResourceReading } from '@shared/resource-monitor-public';
import { rendererLogger } from '@/lib/log';
import { Button } from '@/components/ui/Button';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { ResourceMonitorView } from '@renderer/features/command-palette/resource-monitor-view';
import { ResourceSamplingStatus } from './resource-sampling-status';
import { tokenColor, useChartTheme } from '@/components/usage/useChartTheme';
import './resource-timeline.css';
const log = rendererLogger('resource-monitor/timeline');
const VChart = lazy(() => import('@visactor/react-vchart').then((m) => ({ default: m.VChart })));
const CHART_OPTIONS = { mode: 'desktop-browser' as const };

type Range = 'all' | '15m' | '1h';
type Metric = 'stall' | 'cpu' | 'memory';
const CAPTURE_SECONDS = 10;
const RANGE_MS: Record<Range, number> = { all: 0, '15m': 900_000, '1h': 3_600_000 };

/**
 * The resource monitor page body (and, compact, the floating window): headline numbers, the two charts, and one
 * process table that shows live data until a moment on a chart is picked, then that moment until "Back to live".
 */
export const ResourceTimeline = observer(function ResourceTimeline({ compact = false, live = false, onFloat }: { compact?: boolean; live?: boolean; onFloat?: () => void }) {
  const { translate: t } = useSessionMessages();
  const store = appState.resourceMonitor;
  const snapshot = store.snapshot;
  const [history, setHistory] = useState<ResourceHistory | null>(null);
  const [selected, setSelected] = useState<ResourceSnapshot | null>(null);
  const [range, setRange] = useState<Range>('all');
  const tick = snapshot ? Math.floor(snapshot.timestamp / 5000) : null;
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const last = history?.points.at(-1);
  const data = useMemo(() => timelineData(history?.points ?? []), [history]);
  const peak = useMemo(() => ({ cpu: peakOf(history?.points, 'cpu'), memory: peakOf(history?.points, 'memory') }), [history]);
  // Live, the headline follows the live sample like the table below it (the last recorded point until the first one
  // arrives); off, it is the last recorded point — the store keeps its final snapshot after monitoring stops.
  // The numbers come from the same projection the external reading (perf.*) returns.
  const reading = live && snapshot ? publicResourceReading(snapshot) : null;
  const now = reading ? { cpu: reading.cpuPercent ?? last?.cpu, memory: reading.memoryBytes ?? last?.memory } : { cpu: last?.cpu, memory: last?.memory };
  const recent = reading?.recent;
  const footprint = (snapshot?.memoryMetric ?? 'rss') === 'footprint';
  const [capture, setCapture] = useState<ResourceCapture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const ranges = (['15m', '1h', 'all'] as const).map((value) => ({ value, label: t(value === 'all' ? 'resourceMonitor.all' : value === '1h' ? 'resourceMonitor.range1h' : 'resourceMonitor.range15m') }));
  const labels = { stall: t('resourceMonitor.stallChart'), cpu: t('resourceMonitor.cpuOneCore'), memory: t(footprint ? 'resourceMonitor.memoryFootprint' : 'resourceMonitor.memoryRss'), longFrames: t('resourceMonitor.longFrames'), slowInteractions: t('resourceMonitor.slowInteractions') };
  const fail = (e: unknown) => { log.error({ error: e }, 'resource history request failed'); setError(messageForUser(e)); };
  useEffect(() => {
    let active = true;
    const until = Date.now();
    void rpc.resourceMonitor.history(RANGE_MS[range] ? until - RANGE_MS[range] : 0, until).then((res) => {
      if (active) { setHistory(res.data); setError(''); }
    }).catch((e: unknown) => { if (active) fail(e); });
    return () => { active = false; };
  }, [tick, range, revision]);
  const action = async (kind: 'export' | 'clear') => {
    try {
      if (kind === 'export') await rpc.resourceMonitor.exportHistory(t('resourceMonitor.export'));
      else { await rpc.resourceMonitor.clearHistory(); setHistory(null); setSelected(null); const res = await rpc.resourceMonitor.history(); setHistory(res.data); }
    } catch (e) { fail(e); }
  };
  const record = async () => {
    setCapturing(true);
    try { setCapture((await rpc.resourceMonitor.capture(CAPTURE_SECONDS)).data); setError(''); }
    catch (e) { fail(e); }
    finally { setCapturing(false); }
  };
  const select = (id: number) => { void rpc.resourceMonitor.point(id).then((res) => {
    setSelected(res.data); if (!res.data) setError(t('resourceMonitor.expired'));
  }).catch(fail); };
  const lastMinute = t('resourceMonitor.lastMinute');
  const pageTiles = [
    { key: 'longFrames', label: labels.longFrames, value: countText(recent?.longFrames), note: `${lastMinute} · ${t('resourceMonitor.longFramesNote')}` },
    { key: 'slowInteractions', label: labels.slowInteractions, value: countText(recent?.slowInteractions), note: `${lastMinute} · ${t('resourceMonitor.slowInteractionsNote')}` },
    { key: 'styleLayout', label: t('resourceMonitor.styleLayout'), value: recent?.styleLayoutMs === undefined ? '–' : `${Math.round(recent.styleLayoutMs)} ms`, note: `${lastMinute} · ${t('resourceMonitor.styleLayoutNote')}` },
  ];
  const tiles = [
    { key: 'cpu' as const, label: 'CPU', value: cpuText(now.cpu), note: `${t('resourceMonitor.oneCore')} · ${t('resourceMonitor.peak', { value: cpuText(peak.cpu) })} · ${t('resourceMonitor.cpuSecondary')}` },
    { key: 'memory' as const, label: t('resourceMonitor.memory'), value: memoryText(now.memory), note: `${t(footprint ? 'resourceMonitor.footprintSum' : 'resourceMonitor.rssSum')} · ${t('resourceMonitor.peak', { value: memoryText(peak.memory) })}` },
  ];
  const chart = (metric: Metric, height: number) => <div aria-label={labels[metric]} style={{ height }}><TimelineChart data={data} metric={metric} compact={compact} select={select} labels={labels} /></div>;

  if (compact) return <section className="space-y-3 text-xs" aria-label={t('resourceMonitor.timeline')}>
    <ResourceSamplingStatus />
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <div className="whitespace-nowrap">
        <div className="text-foreground-muted">{labels.longFrames} · {labels.slowInteractions}</div>
        <div className="text-base font-medium text-foreground tabular-nums">{countText(recent?.longFrames)} · {countText(recent?.slowInteractions)}</div>
        <div className="text-foreground-muted">{lastMinute}</div>
      </div>
      {history?.points.length ? chart('stall', 48) : <span className="text-foreground-muted">{t('resourceMonitor.empty')}</span>}
    </div>
    {tiles.map((tile) => <div key={tile.key} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <div className="whitespace-nowrap">
        <div className="text-foreground-muted">{tile.label}</div>
        <div className="text-base font-medium text-foreground tabular-nums">{tile.value}</div>
        <div className="text-foreground-muted tabular-nums">{t('resourceMonitor.peak', { value: tile.key === 'cpu' ? cpuText(peak.cpu) : memoryText(peak.memory) })}</div>
      </div>
      {history?.points.length ? chart(tile.key, 48) : <span className="text-foreground-muted">{t('resourceMonitor.empty')}</span>}
    </div>)}
  </section>;

  const tableHeader = selected
    ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-live-soft px-3 py-2" role="status">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('resourceMonitor.snapshotAt', { time: new Date(selected.timestamp).toLocaleString() })}</div>
        <div className="text-foreground-muted">{sampleContext(selected, t)}</div>
        {selected.context?.unavailable && <div className="text-foreground-muted">{selected.context.unavailable}</div>}
      </div>
      <Button size="sm" variant="primary" onClick={() => setSelected(null)}>{t(live ? 'resourceMonitor.backToLive' : 'resourceMonitor.closeSnapshot')}</Button>
    </div>
    : <h3 className="text-sm font-medium">{t('resourceMonitor.liveProcesses')}</h3>;

  return <section className="space-y-5 text-xs" aria-label={t('resourceMonitor.timeline')}>
    <ResourceSamplingStatus />
    <div className="grid grid-cols-3 gap-3">
      {pageTiles.map((tile) => <div key={tile.key} className="space-y-1 rounded-md border border-border px-3 py-3">
        <div className="text-foreground-muted">{tile.label}</div>
        <div className="text-lg font-medium text-foreground tabular-nums">{tile.value}</div>
        <div className="text-foreground-muted">{tile.note}</div>
      </div>)}
    </div>
    {snapshot?.page?.countersUnavailable && live && <p className="text-foreground-muted">{t(snapshot.page.countersUnavailable === 'off' ? 'resourceMonitor.countersOff' : snapshot.page.countersUnavailable === 'no-window' ? 'resourceMonitor.countersNoWindow' : 'resourceMonitor.countersFailed')}</p>}
    <div className="grid grid-cols-2 gap-3">
      {tiles.map((tile) => <div key={tile.key} className="space-y-1 rounded-md border border-border px-3 py-3">
        <div className="text-foreground-muted">{tile.label}</div>
        <div className="text-lg font-medium text-foreground tabular-nums">{tile.value}</div>
        <div className="text-foreground-muted tabular-nums">{tile.note}</div>
      </div>)}
    </div>
    <div className="space-y-3">
      <div className="gg-resource-toolbar">
        <div className="gg-resource-range"><SegmentedTabs items={ranges} value={range} onChange={setRange} ariaLabel={t('resourceMonitor.range')} /></div>
        <div className="gg-resource-actions">
        {live && <Button size="sm" variant="ghost" disabled={capturing} onClick={() => void record()}>{t(capturing ? 'resourceMonitor.capturing' : 'resourceMonitor.capture', { seconds: CAPTURE_SECONDS })}</Button>}
        {onFloat && <Button size="sm" variant="ghost" onClick={onFloat}>{t('resourceMonitor.float')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => void action('export')}>{t('resourceMonitor.export')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void action('clear')}>{t('resourceMonitor.clear')}</Button>
        </div>
      </div>
      {history?.points.length ? (['stall', 'cpu', 'memory'] as const).map((metric) => <div key={metric} className="space-y-1">
        <div className="text-foreground-muted">{metric === 'stall' ? labels.stall : tiles.find((tile) => tile.key === metric)?.label}</div>
        {chart(metric, 96)}
      </div>) : <p className="text-foreground-muted">{t('resourceMonitor.empty')}</p>}
      {capture && <CaptureSummary capture={capture} />}
      <p className="text-foreground-muted">{t('resourceMonitor.stored', { count: history?.count ?? 0, bytes: formatBytes(history?.bytes ?? 0), time: last ? formatClock(last.timestamp) : '–' })} {t('resourceMonitor.retention')}</p>
    </div>
    {(error || snapshot?.recordingError) && <p role="alert">{error || t('resourceMonitor.writeFailed')} <Button size="sm" variant="ghost" onClick={() => setRevision((n) => n + 1)}>{t('resourceMonitor.retry')}</Button></p>}
    {selected || live
      ? <ResourceMonitorView snapshot={selected ?? snapshot} live={!selected} header={tableHeader} />
      : history?.points.length ? <p className="text-foreground-muted">{t('resourceMonitor.pickHint')}</p> : null}
  </section>;
});

function sampleContext(sample: ResourceSnapshot, t: ReturnType<typeof useSessionMessages>['translate']): string {
  const tasks = sample.context?.localTasks;
  const windows = sample.context?.windows ?? [];
  const state = (w: (typeof windows)[number]) => t(!w.visible ? 'resourceMonitor.hidden' : w.minimized ? 'resourceMonitor.minimized' : 'resourceMonitor.visible');
  const titles = windows.map((w) => `${w.title} (${state(w)})`).join(' / ') || '–';
  const focused = windows.filter((w) => w.focused).map((w) => w.title).join(' / ') || '–';
  return `${t('resourceMonitor.context')}: ${titles} · ${t('resourceMonitor.foreground')}: ${focused} · ${t('resourceMonitor.localTasks')} ${tasks?.total ?? '–'} (${t('resourceMonitor.running')} ${tasks?.running ?? '–'} · ${t('resourceMonitor.waiting')} ${tasks?.waiting ?? '–'} · ${t('resourceMonitor.scheduled')} ${tasks?.scheduled ?? '–'})`;
}

type ChartData = { id: string; values: (ResourcePoint & { mem?: number; stall?: number; series: string })[] }[];
type DimensionClick = { dimensionInfo?: { data: { datum: { id?: number }[] }[] }[] };

/** Both charts plot this one dataset, so their time axes share the same extent. */
function timelineData(points: ResourcePoint[]): ChartData {
  let segment = 0;
  return [{ id: 'history', values: points.map((p, i) => {
    if (i && (p.runId !== points[i - 1].runId || p.timestamp - points[i - 1].timestamp > 30_000)) segment++;
    const stall = p.styleLayoutMs === undefined || !p.pageIntervalMs ? undefined : (p.styleLayoutMs / p.pageIntervalMs) * 1000;
    return { ...p, mem: p.memory === undefined ? undefined : p.memory / 1048576, stall, series: String(segment) };
  }) }];
}

const peakOf = (points: ResourcePoint[] | undefined, key: 'cpu' | 'memory') => {
  const values = (points ?? []).flatMap((p) => p[key] ?? []);
  return values.length ? Math.max(...values) : undefined;
};
const cpuText = (cpu: number | undefined) => (cpu === undefined ? '–' : `${cpu.toFixed(1)}%`);
const countText = (n: number | undefined) => (n === undefined ? '–' : String(n));
const memoryText = (memory: number | undefined) => (memory === undefined ? '–' : formatBytes(memory));
// Memory ticks switch to GB at the same 1024 MB boundary as formatBytes, so an axis and the readout beside it agree.
const axisLabel = (metric: Metric, v: number) => (metric === 'stall' ? `${Math.round(v)} ms/s` : metric === 'cpu' ? `${Math.round(v)}%` : v >= 1024 ? `${Number((v / 1024).toFixed(1))} GB` : `${Math.round(v)} MB`);
const stallText = (d: { stall?: number }) => (d.stall === undefined ? '–' : `${d.stall.toFixed(1)} ms/s`);
// A fixed label column keeps the two plot areas the same width, so one time lines up across both charts.
const AXIS_WIDTH = 68;

type Labels = { stall: string; cpu: string; memory: string; longFrames: string; slowInteractions: string };
function TimelineChart({ data, metric, compact, select, labels }: { data: ChartData; metric: Metric; compact: boolean; select: (id: number) => void; labels: Labels }) {
  const theme = useChartTheme();
  const stroke = tokenColor('--live');
  // VChart can update data without rebuilding axes/layout; keep its spec stable between samples.
  const spec = useMemo(() => ({ type: 'line', theme, animation: false, background: 'transparent', padding: compact ? 2 : { top: 8, right: 8, bottom: 0, left: 0 },
    xField: 'timestamp', yField: metric === 'cpu' ? 'cpu' : metric === 'stall' ? 'stall' : 'mem', seriesField: 'series', invalidType: 'link',
    axes: [
      // nice: false — the axis ends at the last sample, so the newest point sits at the right edge.
      { orient: 'bottom', visible: !compact, type: 'time', nice: false, grid: { visible: false }, layers: [{ timeFormat: '%H:%M:%S' }] },
      { orient: 'left', visible: !compact, zero: true, width: AXIS_WIDTH, tick: { tickCount: 3 }, label: { formatMethod: (v: number | string) => axisLabel(metric, Number(v)) } },
    ],
    line: { style: { stroke, lineWidth: compact ? 1.5 : 2 } }, point: { visible: false }, legends: { visible: false },
    crosshair: { xField: { visible: !compact, line: { type: 'line', style: { lineWidth: 1 } } } },
    tooltip: { visible: !compact, mark: { visible: false }, dimension: {
      title: { value: (d: ResourcePoint) => formatClock(d.timestamp) },
      content: [
        { key: labels.stall, value: stallText },
        { key: labels.longFrames, value: (d: ResourcePoint) => countText(d.longFrames) },
        { key: labels.slowInteractions, value: (d: ResourcePoint) => countText(d.slowInteractions) },
        { key: labels.cpu, value: (d: ResourcePoint) => cpuText(d.cpu) },
        { key: labels.memory, value: (d: ResourcePoint) => memoryText(d.memory) },
      ],
    } },
  }), [theme, stroke, compact, metric, labels.stall, labels.longFrames, labels.slowInteractions, labels.cpu, labels.memory]);
  const onDimensionClick = (event: DimensionClick) => {
    const id = event.dimensionInfo?.[0]?.data.flatMap((d) => d.datum).find((d) => d.id)?.id;
    if (id) select(id);
  };
  return <Suspense><VChart spec={spec as never} data={data} options={CHART_OPTIONS} onDimensionClick={onDimensionClick} /></Suspense>;
}

/** The long tasks of a recorded stretch: where a stall went (style, layout, script) and which app functions ran. */
function CaptureSummary({ capture }: { capture: ResourceCapture }) {
  const { translate: t } = useSessionMessages();
  return <div className="space-y-1" aria-label={t('resourceMonitor.captureTitle')}>
    <div className="text-foreground-muted">{t('resourceMonitor.captureResult', { seconds: capture.seconds, tasks: capture.longTasks, ms: Math.round(capture.longTaskMs), busy: Math.round(capture.mainThreadBusyMs) })}</div>
    {capture.tasks.map((task, i) => <div key={i} className="grid grid-cols-[4rem_1fr] gap-2 tabular-nums">
      <span className="text-right text-foreground">{Math.round(task.ms)} ms</span>
      <span className="truncate text-foreground-muted" title={task.top.map((f) => `${f.frame} ${f.ms} ms`).join('\n')}>
        {t('resourceMonitor.captureTask', { style: Math.round(task.styleMs), elements: task.styleElements, layout: Math.round(task.layoutMs), script: Math.round(task.scriptMs) })}{task.top[0] ? ` · ${task.top[0].frame}` : ''}
      </span>
    </div>)}
  </div>;
}
