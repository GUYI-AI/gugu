import { describe, expect, it } from 'vitest';
import { HISTORY_BATCH_SIZE, HistoryBatchJob, type BatchJobProgress } from './history-batch-job';

const describeError = () => 'could not do it';
const items = (n: number) => Array.from({ length: n }, (_, index) => index);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('HistoryBatchJob (bulk archive / restore)', () => {
  it('runs in batches of 50, reports once per batch, keeps the given order', async () => {
    const reports: BatchJobProgress[] = [];
    // 后来的先回:批内并发的先后不定,报出来的仍按给的顺序。
    const job = new HistoryBatchJob(items(120), (n) => new Promise<number>((resolve) => setTimeout(() => resolve(n * 2), 5 - (n % 5))), {
      describeError,
      onBatch: (progress) => reports.push(progress),
    });
    const end = await job.run();
    expect(HISTORY_BATCH_SIZE).toBe(50);
    expect(reports).toEqual([
      { processed: 50, total: 120 },
      { processed: 100, total: 120 },
      { processed: 120, total: 120 },
    ]);
    expect(end.done.map(({ item }) => item)).toEqual(items(120));
    expect(end.done[7].result).toBe(14);
    expect(end).toMatchObject({ failed: [], notAttempted: [], stopped: false });
  });

  it('never has more than `concurrency` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const job = new HistoryBatchJob(
      items(30),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
      },
      { describeError, concurrency: 3 }
    );
    await job.run();
    expect(peak).toBe(3);
  });

  it('one failure does not stop the rest; the reason is the user-facing line, not the raw error', async () => {
    const job = new HistoryBatchJob(
      items(4),
      async (n) => {
        if (n === 2) throw new Error('ECONNRESET internal detail');
        return n;
      },
      { describeError }
    );
    const end = await job.run();
    expect(end.done.map(({ item }) => item)).toEqual([0, 1, 3]);
    expect(end.failed).toEqual([{ item: 2, reason: 'could not do it' }]);
  });

  it('stop finishes the batch in hand, then leaves the rest untouched', async () => {
    const seen: number[] = [];
    const job: HistoryBatchJob<number, void> = new HistoryBatchJob(
      items(130),
      async (n) => {
        seen.push(n);
        await tick();
      },
      { describeError, onBatch: ({ processed }) => (processed === 50 ? job.stop() : undefined) }
    );
    const end = await job.run();
    expect(job.stopping).toBe(true);
    expect(seen).toHaveLength(50);
    expect(end.stopped).toBe(true);
    expect(end.done).toHaveLength(50);
    expect(end.notAttempted).toEqual(items(130).slice(50));
  });
});
