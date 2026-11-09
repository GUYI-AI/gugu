import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { app, contentTracing, webContents } from 'electron';
import type { ResourceCapture, ResourceCaptureTask } from '@shared/resource-monitor';

/**
 * "Record a stretch": a few seconds of the main window's timeline, summarised here into its long tasks — how much of
 * each went to style, layout and script, how many elements one style pass touched, and which app functions the script
 * time sampled into. This is what locates a stall in code; the always-on page metrics only say that one happened.
 * Runs on a click or an authorised device action, never on a timer. The raw trace goes to a temp file that is read once
 * and deleted; only the summary leaves this module (function names and app bundle file names, no paths or content).
 */
export const CAPTURE_MAX_SECONDS = 15;
const LONG_TASK_MS = 50;
const CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-v8.cpu_profiler', 'v8.execute'];

type CallFrame = { functionName?: string; url?: string; lineNumber?: number };
type ProfileNode = { id: number; parent?: number; callFrame: CallFrame };
export type TraceEvent = {
  ph?: string; pid?: number; tid?: number; ts?: number; dur?: number; name?: string;
  args?: { name?: string; elementCount?: number; data?: { startTime?: number; cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] }; timeDeltas?: number[] } };
};

let tracing = false;
/**
 * Raw traces are browser-wide and can hold full URLs, so they go to the app's own folder, never the shared temp dir.
 * A crash between stopping and deleting leaves one behind; startup clears the folder.
 */
const traceDir = () => path.join(app.getPath('userData'), 'resource-traces');
export async function clearTraceLeftovers(): Promise<void> { await rm(traceDir(), { recursive: true, force: true }); }

/**
 * Record `ms` of a Chromium trace and return its events; the raw trace is read once and deleted.
 * One trace at a time for the whole app (this module's stretch and the deep sample's memory dump).
 */
export async function recordTrace<E>(config: Parameters<typeof contentTracing.startRecording>[0], ms: number, name: string): Promise<E[]> {
  if (tracing) throw new Error('another recording is in progress');
  tracing = true;
  try {
    await mkdir(traceDir(), { recursive: true, mode: 0o700 });
    await contentTracing.startRecording(config);
    await new Promise((resolve) => setTimeout(resolve, ms));
    const written = await contentTracing.stopRecording(path.join(traceDir(), `${name}-${process.pid}-${Date.now()}.json`));
    try {
      const trace = JSON.parse(await readFile(written, 'utf8')) as { traceEvents?: E[] } | E[];
      return Array.isArray(trace) ? trace : (trace.traceEvents ?? []);
    } finally {
      await rm(written, { force: true });
    }
  } finally {
    tracing = false;
  }
}

/** App code is served from gugu-app://app/; only its bundle file name (without the content hash) is reported. */
function frameLabel(frame: CallFrame): string | null {
  if (!frame.url?.startsWith('gugu-app://app/')) return null;
  const name = (new URL(frame.url).pathname.split('/').pop() ?? '').replace(/-[A-Za-z0-9_-]{8}\.js$/, '').replace(/\.js$/, '');
  if (/^vendor/.test(name)) return null;
  return `${frame.functionName || '(anonymous)'}@${name}:${(frame.lineNumber ?? 0) + 1}`;
}

export function summarizeTrace(events: readonly TraceEvent[], pids: ReadonlySet<number>, seconds: number): ResourceCapture {
  const mainThreads = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && pids.has(e.pid ?? -1)).map((e) => `${e.pid}:${e.tid}`));
  const onMain = events.filter((e) => e.ph === 'X' && typeof e.ts === 'number' && mainThreads.has(`${e.pid}:${e.tid}`)).sort((a, b) => a.ts! - b.ts!);
  const tops: TraceEvent[] = [];
  for (const e of onMain) {
    if (e.name !== 'ThreadControllerImpl::RunTask' && e.name !== 'RunTask') continue;
    const last = tops.at(-1);
    if (!last || e.ts! >= last.ts! + (last.dur ?? 0)) tops.push(e);
  }
  // CPU profile samples (same clock as the trace), per renderer process.
  const samples: { ts: number; stack: CallFrame[] }[] = [];
  const nodes = new Map<string, ProfileNode>();
  const clock = new Map<number, number>();
  for (const e of events.filter((x) => pids.has(x.pid ?? -1) && (x.name === 'Profile' || x.name === 'ProfileChunk')).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    const data = e.args?.data;
    if (e.name === 'Profile') { clock.set(e.pid!, data?.startTime ?? 0); continue; }
    for (const node of data?.cpuProfile?.nodes ?? []) nodes.set(`${e.pid}:${node.id}`, node);
    let t = clock.get(e.pid!) ?? 0;
    const ids = data?.cpuProfile?.samples ?? [];
    ids.forEach((id, i) => {
      t += data?.timeDeltas?.[i] ?? 0;
      const stack: CallFrame[] = [];
      for (let n = nodes.get(`${e.pid}:${id}`); n; n = n.parent === undefined ? undefined : nodes.get(`${e.pid}:${n.parent}`)) stack.push(n.callFrame);
      samples.push({ ts: t, stack });
    });
    clock.set(e.pid!, t);
  }
  const ms = (us: number) => Math.round(us / 100) / 10;
  const tasks: ResourceCaptureTask[] = tops.filter((t) => (t.dur ?? 0) >= LONG_TASK_MS * 1000).map((task) => {
    const end = task.ts! + task.dur!;
    const inside = onMain.filter((e) => e.ts! >= task.ts! && e.ts! < end);
    const sum = (name: string) => inside.filter((e) => e.name === name).reduce((a, e) => a + (e.dur ?? 0), 0);
    const anchors = new Map<string, number>();
    let script = 0;
    const own = samples.filter((s) => s.ts >= task.ts! && s.ts < end);
    own.forEach((s, i) => {
      const leaf = s.stack[0]?.functionName ?? '';
      if (!s.stack.length || /^\((idle|program|garbage collector|root)\)$/.test(leaf)) return;
      const dt = (own[i + 1]?.ts ?? s.ts + 100) - s.ts;
      script += dt;
      const label = s.stack.map(frameLabel).find(Boolean) ?? '(library code)';
      anchors.set(label, (anchors.get(label) ?? 0) + dt);
    });
    return {
      ms: ms(task.dur!),
      styleMs: ms(sum('UpdateLayoutTree')),
      styleElements: Math.max(0, ...inside.filter((e) => e.name === 'UpdateLayoutTree').map((e) => e.args?.elementCount ?? 0)),
      layoutMs: ms(sum('Layout')),
      scriptMs: ms(script),
      top: [...anchors].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([frame, us]) => ({ frame, ms: ms(us) })),
    };
  });
  const busy = tops.reduce((a, t) => a + (t.dur ?? 0), 0);
  return {
    seconds,
    mainThreadBusyMs: ms(busy),
    longTasks: tasks.length,
    longTaskMs: Math.round(tasks.reduce((a, t) => a + t.ms, 0) * 10) / 10,
    tasks: tasks.sort((a, b) => b.ms - a.ms).slice(0, 10),
  };
}

export async function captureStretch(seconds: number): Promise<ResourceCapture> {
  const span = Math.max(1, Math.min(CAPTURE_MAX_SECONDS, Math.round(seconds)));
  const pids = new Set(webContents.getAllWebContents()
    .filter((c) => !c.isDestroyed() && c.getType() === 'window' && c.getURL().startsWith('gugu-app://app/'))
    .map((c) => c.getOSProcessId()));
  if (!pids.size) throw new Error('no main window to record');
  const events = await recordTrace<TraceEvent>({ included_categories: CATEGORIES, excluded_categories: ['*'] }, span * 1000, 'capture');
  return summarizeTrace(events, pids, span);
}
