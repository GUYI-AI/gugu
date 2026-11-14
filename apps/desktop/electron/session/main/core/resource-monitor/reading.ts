import { publicResourcePoint, publicResourceReading, type PublicResourcePoint, type PublicResourceReading } from '@shared/resource-monitor-public';
import type { ResourceCapture } from '@shared/resource-monitor';
import { captureStretch } from './capture';
import { resourceHistory } from './history';
import { resourceSamplingSince, sampleOnDemand } from './resource-sampler';

/**
 * What every reader outside the monitor page gets (device actions `perf.*`): the last recorded sample and the history the page
 * draws, through one projection. The reader was granted this, which is the consent to sample: with the setting off, a reading
 * starts the sampler for a while (`sampleOnDemand`), and history says honestly from when it has records.
 */
export async function currentReading(): Promise<PublicResourceReading> {
  return publicResourceReading(await sampleOnDemand());
}

export const HISTORY_MAX_SPAN_MS = 24 * 60 * 60 * 1000;
export async function historyReading(since: number, until: number): Promise<{ points: PublicResourcePoint[]; count: number; note?: string }> {
  await sampleOnDemand();
  const from = Math.max(since, until - HISTORY_MAX_SPAN_MS);
  const { points, count } = resourceHistory.read(from, until);
  const first = points[0]?.timestamp ?? resourceSamplingSince() ?? until;
  // Nothing is recorded while the monitor is off: say from when there is, ❌ let a quiet stretch read as an idle app.
  const note = first > from + 60_000
    ? `Recorded only from ${new Date(first).toISOString()}: the resource monitor was not sampling before that (it samples while on in Settings → Resource monitor, and for a while after each perf.* reading).`
    : undefined;
  return { points: points.map(publicResourcePoint), count, ...(note ? { note } : {}) };
}

/** A trace of the main window: it needs no sampler, only the grant that let the reader ask. */
export function captureReading(seconds: number): Promise<ResourceCapture> {
  return captureStretch(seconds);
}
