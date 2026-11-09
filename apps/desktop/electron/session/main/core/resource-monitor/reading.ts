import { publicResourcePoint, publicResourceReading, type PublicResourcePoint, type PublicResourceReading } from '@shared/resource-monitor-public';
import type { ResourceCapture } from '@shared/resource-monitor';
import { captureStretch } from './capture';
import { resourceHistory } from './history';
import { latestResourceSnapshot } from './resource-sampler';

/**
 * What every reader outside the monitor page gets (device actions `perf.*`): the last recorded
 * sample and the history the page draws, through one projection. Monitoring off is an error, never an empty reading.
 */
export class ResourceMonitorOffError extends Error {
  constructor() { super('The resource monitor is off on this computer: turn it on in 咕咕 → Settings → Resource monitor.'); this.name = 'ResourceMonitorOffError'; }
}

export function currentReading(): PublicResourceReading {
  const snapshot = latestResourceSnapshot();
  if (!snapshot) throw new ResourceMonitorOffError();
  return publicResourceReading(snapshot);
}

export const HISTORY_MAX_SPAN_MS = 24 * 60 * 60 * 1000;
export function historyReading(since: number, until: number): { points: PublicResourcePoint[]; count: number } {
  if (!latestResourceSnapshot()) throw new ResourceMonitorOffError();
  const { points, count } = resourceHistory.read(Math.max(since, until - HISTORY_MAX_SPAN_MS), until);
  return { points: points.map(publicResourcePoint), count };
}

export function captureReading(seconds: number): Promise<ResourceCapture> {
  if (!latestResourceSnapshot()) throw new ResourceMonitorOffError();
  return captureStretch(seconds);
}
