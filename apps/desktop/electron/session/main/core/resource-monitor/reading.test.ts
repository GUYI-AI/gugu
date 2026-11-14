import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ since: null as number | null, points: [] as Array<{ id: number; timestamp: number }> }));
vi.mock('./resource-sampler', () => ({
  sampleOnDemand: vi.fn(async () => ({ timestamp: 1 })),
  resourceSamplingSince: () => state.since,
}));
vi.mock('./history', () => ({ resourceHistory: { read: vi.fn(() => ({ points: state.points, count: state.points.length })) } }));
vi.mock('./capture', () => ({ captureStretch: vi.fn(async (seconds: number) => ({ seconds })) }));

import { captureReading, historyReading } from './reading';
import { sampleOnDemand } from './resource-sampler';

describe('external resource readings', () => {
  beforeEach(() => { vi.mocked(sampleOnDemand).mockClear(); state.points = []; state.since = null; });

  it('history samples on demand and says from when it has records', async () => {
    state.since = 3_000_000;
    const reading = await historyReading(0, 3_600_000);
    expect(sampleOnDemand).toHaveBeenCalledOnce();
    expect(reading.note).toContain(new Date(3_000_000).toISOString());
  });

  it('history recorded all along: no note', async () => {
    state.points = [{ id: 1, timestamp: 10_000 }];
    expect((await historyReading(0, 3_600_000)).note).toBeUndefined();
  });

  it('capture records without a sampler', async () => {
    expect(await captureReading(5)).toEqual({ seconds: 5 });
    expect(sampleOnDemand).not.toHaveBeenCalled();
  });
});
