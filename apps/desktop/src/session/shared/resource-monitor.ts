import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { RendererMetrics } from './renderer-metrics';
export const RESOURCE_MONITOR_WINDOW_NAME = 'gugu-aux:resource-monitor';
export type ResourceContext = {
  unavailable?: string;
  localTasks?: { total: number; running: number; waiting: number; scheduled: number; unknown: number };
  windows: { id: number; title: string; focused: boolean; visible: boolean; minimized: boolean }[];
};
export const RESOURCE_HISTORY_LIMITS = { points: 10_000, bytes: 64 * 1024 * 1024, ageMs: 24 * 60 * 60 * 1000 };
/** Page columns are per-sample deltas (see ResourcePageMetrics); absent on samples recorded before they existed. */
export type ResourcePoint = {
  id: number; timestamp: number; cpu?: number; memory?: number; runId: string;
  longFrames?: number; slowInteractions?: number; styleLayoutMs?: number; pageIntervalMs?: number;
};
export type ResourceHistory = { points: ResourcePoint[]; count: number; bytes: number; limits: typeof RESOURCE_HISTORY_LIMITS };

/**
 * Per-PTY resource sample. `cpu` is a percentage of one core (can exceed 100
 * on multi-core systems). `memory` is bytes in the snapshot's `memoryMetric`. `pid` is undefined for
 * remote (SSH) PTYs where the owning process runs on the remote host.
 *
 * `providerId` is populated for agent-conversation PTYs. `title` is populated
 * for conversations and user-created shell terminals. They are sourced from
 * the registry at register-time so the renderer can label entries even when
 * the owning project isn't mounted (in which case the renderer-side store join
 * would fail and the row would fall back to a leafId hex).
 */
export interface ResourcePtyEntry {
  ptySessionId: string;
  projectId: string;
  scopeId: string;
  leafId: string;
  pid: number | undefined;
  ppid?: number;
  cpu: number;
  memory: number;
  providerId?: AgentProviderId;
  title?: string;
}

/**
 * Memory + CPU consumed by the Electron app itself (main, renderer, GPU,
 * utility processes). Sampled from `app.getAppMetrics()`. Does not include
 * PTY child processes — those are reported per-entry to avoid double counting.
 */
export interface ResourceAppUsage {
  memoryBytes?: number;
  /** Sum of process CPU since the previous sample. */
  cpuPercent?: number;
}

export type ResourceAppProcessType =
  | 'Browser'
  | 'Tab'
  | 'Utility'
  | 'Zygote'
  | 'Sandbox helper'
  | 'GPU'
  | 'Pepper Plugin'
  | 'Pepper Plugin Broker'
  | 'Unknown';

/**
 * Electron rows after separately attributed runtime/session/PTY PIDs have been removed.
 * Sums of `memory` / `cpu` across these match `ResourceAppUsage`.
 */
export interface ResourceAppProcess {
  pid: number;
  type: ResourceAppProcessType;
  name?: string;
  /**
   * % of one core since the previous sample, from `cpu.cumulativeCPUUsage` deltas. Undefined on a
   * process's first sample: there is nothing to difference yet.
   */
  cpu?: number;
  memory: number;
}

/**
 * What the person feels, measured in the main window since the previous recorded sample (`intervalMs`):
 * long animation frames (>= 50 ms), interactions slower than 100 ms, and — while page counters are on — the time
 * Blink spent recalculating style and doing layout. Process CPU says the app is busy; these say whether it stalls.
 */
export interface ResourcePageMetrics {
  intervalMs: number;
  longFrames: number;
  blockingMs: number;
  slowInteractions: number;
  /** Absent while page counters are switched off or unavailable. */
  styleLayoutMs?: number;
  styleRecalcs?: number;
  layouts?: number;
  /** Current values, not deltas. */
  nodes?: number;
  listeners?: number;
  /** Why the counters are missing: switched off, no main window to read, or the read failed. */
  countersUnavailable?: 'off' | 'no-window' | 'failed';
}

/** One long task (>= 50 ms) of a recorded stretch; `top` = app functions its script time sampled into. */
export interface ResourceCaptureTask {
  ms: number;
  styleMs: number;
  styleElements: number;
  layoutMs: number;
  scriptMs: number;
  top: { frame: string; ms: number }[];
}
/** Summary of a few recorded seconds of the main window (resource-monitor/capture.ts). */
export interface ResourceCapture {
  seconds: number;
  mainThreadBusyMs: number;
  longTasks: number;
  longTaskMs: number;
  /** The ten longest. */
  tasks: ResourceCaptureTask[];
}

export const RESOURCE_RECENT_WINDOW_MS = 60_000;
export interface ResourcePageSummary {
  windowMs: number;
  samples: number;
  longFrames: number;
  slowInteractions: number;
  /** Absent when no sample in the window had page counters. */
  styleLayoutMs?: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuCount: number;
  totalMemoryBytes: number;
  app: ResourceAppUsage;
  appProcesses: ResourceAppProcess[];
  entries: ResourcePtyEntry[];
  /** Non-Electron, non-PTY processes, partitioned by their closest owned root. */
  processGroups?: ResourceProcessGroup[];
  /**
   * `footprint`: memory a process alone accounts for (macOS phys_footprint, Linux anonymous resident + swap,
   * renderer private memory); `memoryFallbacks` processes fell back to RSS. `rss` (older samples, Windows) counts
   * shared pages once per process and overstates the sum.
   */
  memoryMetric?: 'rss' | 'footprint';
  memoryFallbacks?: number;
  page?: ResourcePageMetrics;
  /** Page metrics summed over the recorded samples of the last minute, including this one. */
  recent?: ResourcePageSummary;
  processTreeScope?: 'owned-process-tree' | 'electron-and-pty-roots';
  runId?: string;
  context?: ResourceContext;
  recordingError?: string;
  /** Only while an open monitor page has advanced diagnostics expanded. */
  internals?: { renderers: RendererMetrics[] };
}

export interface ResourceProcessGroup {
  id: string;
  kind: 'runtime' | 'session';
  label: string;
  sessionId?: string;
  projectId?: string;
  cpu?: number;
  memory: number;
  processes: { pid: number; ppid: number; name: string; cpu?: number; memory: number }[];
}

/** Historical samples without process groups keep their original meaning. */
export function resourceTotals(snapshot: ResourceSnapshot): ResourceAppUsage {
  const additional = [...snapshot.entries, ...(snapshot.processGroups ?? [])];
  return {
    memoryBytes: snapshot.app.memoryBytes === undefined ? undefined : snapshot.app.memoryBytes + additional.reduce((sum, item) => sum + item.memory, 0),
    cpuPercent: snapshot.app.cpuPercent === undefined ? undefined : snapshot.app.cpuPercent + additional.reduce((sum, item) => sum + (item.cpu ?? 0), 0),
  };
}
