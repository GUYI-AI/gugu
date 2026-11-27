/**
 * 批量归档 / 恢复的跑法(第 2 稿行为表):每批 50 条,批内并发几条、批与批串着;每批回来报一次(调用方一次状态更新);
 * 「停止」= 手上这一批做完就停,做了的就是做了,没轮到的原样不动。一条失败不拦别的,结束时逐条带原因。
 * 永久删除另有一套(permanent-delete-flow:先给 8 秒撤销、一批一次调用);这里每条一次调用(主进程只有单条的归档 / 恢复)。
 */

export const HISTORY_BATCH_SIZE = 50;
/** 一批里同时在路上的条数:归档要停 agent、改身份,一条几百毫秒;一次全发出去会把那台机器压住。 */
export const HISTORY_BATCH_CONCURRENCY = 5;

export type BatchFailure<T> = { item: T; reason: string };

export type BatchJobResult<T, R> = {
  done: Array<{ item: T; result: R }>;
  failed: Array<BatchFailure<T>>;
  /** 停止后没轮到的。 */
  notAttempted: T[];
  stopped: boolean;
};

export type BatchJobProgress = { processed: number; total: number };

export class HistoryBatchJob<T, R> {
  private stopRequested = false;
  private processed = 0;

  constructor(
    private readonly items: readonly T[],
    private readonly runOne: (item: T) => Promise<R>,
    private readonly options: {
      batchSize?: number;
      concurrency?: number;
      /** 一条失败记成什么原因(调用方归类、配译好的话;原文进日志,❌ 原样端给用户)。 */
      describeError: (error: unknown) => string;
      onBatch?: (progress: BatchJobProgress, batch: { done: Array<{ item: T; result: R }>; failed: Array<BatchFailure<T>> }) => void;
    }
  ) {}

  stop(): void {
    this.stopRequested = true;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  async run(): Promise<BatchJobResult<T, R>> {
    const size = this.options.batchSize ?? HISTORY_BATCH_SIZE;
    const concurrency = Math.max(1, this.options.concurrency ?? HISTORY_BATCH_CONCURRENCY);
    const describe = this.options.describeError;
    const done: Array<{ item: T; result: R }> = [];
    const failed: Array<BatchFailure<T>> = [];
    let start = 0;
    for (; start < this.items.length; start += size) {
      if (this.stopRequested) break;
      const batch = this.items.slice(start, start + size);
      const batchDone: Array<{ item: T; result: R }> = [];
      const batchFailed: Array<BatchFailure<T>> = [];
      let next = 0;
      const lane = async () => {
        while (next < batch.length) {
          const item = batch[next];
          next += 1;
          try {
            batchDone.push({ item, result: await this.runOne(item) });
          } catch (error) {
            batchFailed.push({ item, reason: describe(error) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, lane));
      // 批内并发回来的先后不定:按给的顺序报,失败清单与界面上的先后一致。
      const order = new Map(batch.map((item, index) => [item, index]));
      batchDone.sort((a, b) => order.get(a.item)! - order.get(b.item)!);
      batchFailed.sort((a, b) => order.get(a.item)! - order.get(b.item)!);
      done.push(...batchDone);
      failed.push(...batchFailed);
      this.processed += batch.length;
      this.options.onBatch?.({ processed: this.processed, total: this.items.length }, { done: batchDone, failed: batchFailed });
    }
    return { done, failed, notAttempted: this.items.slice(start), stopped: start < this.items.length };
  }
}
