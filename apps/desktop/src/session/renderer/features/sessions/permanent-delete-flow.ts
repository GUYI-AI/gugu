import type { UnreachedMachine } from '@gugu/session-core/session-record/contract';
import type { ArchivedSessionRef, PermanentDeleteFailure, PermanentDeleteOutcome } from '@shared/core/sessions/sessions';

/**
 * 「已归档」里的永久删除怎么跑完一次(owner 2026-11-26「怎么设计一个让用户舒服的删除」,2026-11-27 00:58 大批量)。
 * 只管时序与账,不画任何东西:提示条、进度条、确认框都由调用方照这份快照画。
 *
 *  1. **先给 8 秒反悔**(撤销窗口):行已经从列表里收起,删除还没发生。鼠标停在提示上、窗口失焦时倒计时暂停
 *     (调用方调 pauseUndo / resumeUndo,按原因各记一份:两个原因都没了才接着走)。撤销 = 什么都没删。
 *  2. 窗口过了才真删:按机器分组,每台机器每次最多 50 条(主进程拒收更多),一批一批**串着**调那台机器的
 *     `sessions.permanentlyDeleteSessions` —— 会话在哪台机器就在哪台删(别的机器的会话表里没有已归档的行,
 *     主进程替不了它找)。每批回来报一次(onBatch),调用方一次状态更新收掉这一批,❌ 逐行改 DOM。
 *  3. 跑的中途可以「停止」:手上这一批做完就停,已删的就是删了,没轮到的原样回到已归档(notAttempted)。
 *  4. 结束时没删成的逐条带原因(failed),「重试」只重跑这几条(retryTargets),不再给撤销窗口 —— 用户已经确认过。
 *
 * 一批的回执里既没说删了、也没说失败的那条按失败算(no_receipt),❌ 当成删了。一批整个调不通(机器掉线、
 * 版本太旧)= 这一批每条都失败,原因是那句错误,别的批照跑。
 * 回执合同(B):一台机器只报它自己删掉的行(`withChildren` 只带那台上已归档的子会话);已经删掉的行再请求一次
 * 照样回在 `deleted` 里 —— 所以这里不记「谁已经没了」,重跑、重试都照原样问。
 */

export const PERMANENT_DELETE_UNDO_MS = 8000;
/** 主进程一次最多收这么多条。 */
export const PERMANENT_DELETE_BATCH_MAX = 50;

/** 要删的一行:它的会话、它在哪台机器(null = 本机),和调用方认它的 key(会话历史的行 key)。 */
export type PermanentDeleteTarget = ArchivedSessionRef & { key: string; machine: string | null };
/**
 * 一条没删成的原因(闭集):机器在回执里给的那几种(PermanentDeleteFailure),加上这边才看得到的两种 ——
 * `no_receipt` 回执里没提到这一条;`unreachable` 这一批整个调不通(那台机器问不到 / 调用抛了)。界面按它说话。
 */
export type DeleteFailureReason = PermanentDeleteFailure | 'no_receipt' | 'unreachable';

export type FailedDeleteTarget = PermanentDeleteTarget & { reason: DeleteFailureReason };

/** 在一台机器上删一批;调用方给的实现是 `rpcOn(machine).sessions.permanentlyDeleteSessions`。 */
export type DeleteOnMachine = (
  machine: string | null,
  targets: ArchivedSessionRef[],
  options: { withChildren: boolean }
) => Promise<PermanentDeleteOutcome>;

export type PermanentDeletePhase = 'undo' | 'deleting' | 'stopping' | 'done' | 'undone';

export type PermanentDeleteBatchResult = {
  machine: string | null;
  /** 这一批里删掉的、调用方给过的行。 */
  deletedKeys: string[];
  /** 顺带删掉的(勾了「同时删除子会话」时的子会话),调用方没给过 key。 */
  alsoDeleted: ArchivedSessionRef[];
  failed: FailedDeleteTarget[];
  unreached: UnreachedMachine[];
};

export type PermanentDeleteSnapshot = {
  phase: PermanentDeletePhase;
  total: number;
  /** 已经有了结果的条数(删了的 + 没删成的),进度条按它走:「正在删除 processed / total」。 */
  processed: number;
  deletedCount: number;
  failed: readonly FailedDeleteTarget[];
  unreached: readonly UnreachedMachine[];
  /** 停止后没轮到的那些:原样回到已归档。只在 done 时有。 */
  notAttempted: readonly PermanentDeleteTarget[];
  undoRemainingMs: number;
  undoPaused: boolean;
};

export type Clock = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 按机器分组(机器按第一次出现的先后),每组切成不超过 size 条一批;组内顺序照给的顺序。 */
export function planDeleteBatches(
  targets: readonly PermanentDeleteTarget[],
  size = PERMANENT_DELETE_BATCH_MAX
): Array<{ machine: string | null; targets: PermanentDeleteTarget[] }> {
  if (!Number.isInteger(size) || size < 1 || size > PERMANENT_DELETE_BATCH_MAX) throw new Error(`Invalid delete batch size ${size}`);
  const byMachine = new Map<string | null, PermanentDeleteTarget[]>();
  for (const target of targets) {
    const group = byMachine.get(target.machine);
    if (group) group.push(target);
    else byMachine.set(target.machine, [target]);
  }
  const batches: Array<{ machine: string | null; targets: PermanentDeleteTarget[] }> = [];
  for (const [machine, group] of byMachine) {
    for (let start = 0; start < group.length; start += size) batches.push({ machine, targets: group.slice(start, start + size) });
  }
  return batches;
}

const refKey = (ref: ArchivedSessionRef) => `${ref.projectId}\u0000${ref.sessionId}`;

/** 一批的回执对回调用方给的行。回执里没提到的那条按失败算。 */
export function settleDeleteBatch(
  machine: string | null,
  targets: readonly PermanentDeleteTarget[],
  outcome: PermanentDeleteOutcome
): PermanentDeleteBatchResult {
  const asked = new Map(targets.map((target) => [refKey(target), target]));
  const deleted = new Set(outcome.deleted.map(refKey));
  const failedReason = new Map(outcome.failed.map((failure) => [refKey(failure), failure.reason]));
  const deletedKeys: string[] = [];
  const failed: FailedDeleteTarget[] = [];
  for (const target of targets) {
    const id = refKey(target);
    if (failedReason.has(id)) failed.push({ ...target, reason: failedReason.get(id)! });
    else if (deleted.has(id)) deletedKeys.push(target.key);
    else failed.push({ ...target, reason: 'no_receipt' });
  }
  const alsoDeleted = outcome.deleted.filter((ref) => !asked.has(refKey(ref)));
  return { machine, deletedKeys, alsoDeleted, failed, unreached: outcome.unreached };
}

/**
 * 可暂停的倒计时(撤销窗口)。暂停按原因记:鼠标停在提示上、窗口失焦可以同时成立,两个都没了才接着走。
 */
export class UndoCountdown {
  private remaining: number;
  private resumedAt: number | null = null;
  private handle: unknown = null;
  private readonly pauses = new Set<string>();
  private finished = false;

  constructor(
    ms: number,
    private readonly onExpire: () => void,
    private readonly clock: Clock = systemClock
  ) {
    this.remaining = ms;
  }

  start(): void {
    if (this.finished || this.resumedAt !== null || this.pauses.size > 0) return;
    this.arm();
  }

  pause(reason: string): void {
    if (this.finished) return;
    this.pauses.add(reason);
    if (this.resumedAt === null) return;
    this.remaining = Math.max(0, this.remaining - (this.clock.now() - this.resumedAt));
    this.resumedAt = null;
    this.clock.clearTimeout(this.handle);
    this.handle = null;
  }

  resume(reason: string): void {
    if (this.finished || !this.pauses.delete(reason) || this.pauses.size > 0) return;
    this.arm();
  }

  /** 收掉,不再到点(撤销了,或提前提交了)。 */
  cancel(): void {
    this.finished = true;
    if (this.handle !== null) this.clock.clearTimeout(this.handle);
    this.handle = null;
    this.resumedAt = null;
  }

  get remainingMs(): number {
    if (this.finished) return 0;
    return this.resumedAt === null ? this.remaining : Math.max(0, this.remaining - (this.clock.now() - this.resumedAt));
  }

  get paused(): boolean {
    return this.pauses.size > 0;
  }

  private arm(): void {
    this.resumedAt = this.clock.now();
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.cancel();
      this.onExpire();
    }, this.remaining);
  }
}

export type PermanentDeleteRunOptions = {
  targets: readonly PermanentDeleteTarget[];
  withChildren: boolean;
  deleteOn: DeleteOnMachine;
  /** 0 = 不给撤销窗口,直接删(重试那几条:已经确认过)。 */
  undoMs?: number;
  batchSize?: number;
  clock?: Clock;
  /** 一批整个调不通时(这一批每条记 `unreachable`):原文交给调用方进日志,❌ 端给用户(user-copy-leak)。 */
  onCallFailed?: (machine: string | null, error: unknown) => void;
  /** 状态变了(进入删除、每批之后、结束)。 */
  onChange?: (snapshot: PermanentDeleteSnapshot) => void;
  /**
   * 每批回来一次:调用方在一次状态更新里收掉这一批(deletedKeys 的行 + alsoDeleted 的子会话行)。
   * 紧跟着同步调 onChange,两者在同一个回合里,React 合成一次渲染。
   */
  onBatch?: (result: PermanentDeleteBatchResult) => void;
};

/** 一次永久删除,从撤销窗口到最后一批。 */
export class PermanentDeleteRun {
  private phase: PermanentDeletePhase = 'undo';
  private readonly targets: readonly PermanentDeleteTarget[];
  private readonly countdown: UndoCountdown;
  private processed = 0;
  private deletedCount = 0;
  private readonly failed: FailedDeleteTarget[] = [];
  private readonly unreached: UnreachedMachine[] = [];
  private notAttempted: PermanentDeleteTarget[] = [];
  private started = false;
  private stopRequested = false;
  private settle!: (snapshot: PermanentDeleteSnapshot) => void;
  /** 结束(删完、停完)或撤销之后兑现,带最后那份快照。 */
  readonly finished: Promise<PermanentDeleteSnapshot>;

  constructor(private readonly options: PermanentDeleteRunOptions) {
    if (options.targets.length === 0) throw new Error('Nothing to delete');
    const seen = new Set<string>();
    for (const target of options.targets) {
      if (seen.has(target.key)) throw new Error(`Duplicate delete target ${target.key}`);
      seen.add(target.key);
    }
    this.targets = [...options.targets];
    planDeleteBatches(this.targets, options.batchSize); // validates the size up front
    this.countdown = new UndoCountdown(options.undoMs ?? PERMANENT_DELETE_UNDO_MS, () => this.beginDeleting(), options.clock);
    this.finished = new Promise((resolve) => (this.settle = resolve));
  }

  /** 开始:进撤销窗口;undoMs 为 0 时直接删。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    if ((this.options.undoMs ?? PERMANENT_DELETE_UNDO_MS) <= 0) {
      this.countdown.cancel();
      void this.beginDeleting();
      return;
    }
    this.countdown.start();
    this.emit();
  }

  /** 撤销:只在撤销窗口里有效。返回是否撤成了(过了窗口 = false,删除已经开始)。 */
  undo(): boolean {
    if (this.phase !== 'undo') return false;
    this.countdown.cancel();
    this.phase = 'undone';
    this.emit();
    this.settle(this.snapshot());
    return true;
  }

  /** 不等窗口了,现在就删(又开了一次删除:上一次的反悔机会让给新的那一次)。 */
  commitNow(): void {
    if (this.phase !== 'undo') return;
    this.countdown.cancel();
    void this.beginDeleting();
  }

  pauseUndo(reason: string): void {
    if (this.phase !== 'undo') return;
    this.countdown.pause(reason);
    this.emit();
  }

  resumeUndo(reason: string): void {
    if (this.phase !== 'undo') return;
    this.countdown.resume(reason);
    this.emit();
  }

  /** 停止:手上这一批做完就停,没轮到的原样留在已归档。 */
  stop(): void {
    if (this.phase !== 'deleting') return;
    this.stopRequested = true;
    this.phase = 'stopping';
    this.emit();
  }

  /** 没删成的那几条,拿去重跑(新开一次 run,undoMs: 0)。 */
  retryTargets(): PermanentDeleteTarget[] {
    return this.failed.map(({ reason: _reason, ...target }) => target);
  }

  snapshot(): PermanentDeleteSnapshot {
    return {
      phase: this.phase,
      total: this.targets.length,
      processed: this.processed,
      deletedCount: this.deletedCount,
      failed: [...this.failed],
      unreached: [...this.unreached],
      notAttempted: [...this.notAttempted],
      undoRemainingMs: this.phase === 'undo' ? this.countdown.remainingMs : 0,
      undoPaused: this.phase === 'undo' && this.countdown.paused,
    };
  }

  private async beginDeleting(): Promise<void> {
    if (this.phase !== 'undo') return;
    this.phase = 'deleting';
    this.emit();
    const batches = planDeleteBatches(this.targets, this.options.batchSize);
    let next = 0;
    for (; next < batches.length; next++) {
      if (this.stopRequested) break;
      const { machine, targets } = batches[next];
      // 前一批连带删掉的子会话又被单独勾了也照问:主进程幂等,已经删掉的行再请求一次照样回在 deleted 里(B 的回执合同)。
      let result: PermanentDeleteBatchResult;
      try {
        const outcome = await this.options.deleteOn(
          machine,
          targets.map(({ projectId, sessionId }) => ({ projectId, sessionId })),
          { withChildren: this.options.withChildren }
        );
        result = settleDeleteBatch(machine, targets, outcome);
      } catch (error) {
        this.options.onCallFailed?.(machine, error);
        result = {
          machine,
          deletedKeys: [],
          alsoDeleted: [],
          failed: targets.map((target) => ({ ...target, reason: 'unreachable' as const })),
          unreached: [],
        };
      }
      this.processed += targets.length;
      this.deletedCount += result.deletedKeys.length;
      this.failed.push(...result.failed);
      for (const machineNotReached of result.unreached) {
        if (!this.unreached.some((known) => known.deviceId === machineNotReached.deviceId && known.label === machineNotReached.label)) {
          this.unreached.push(machineNotReached);
        }
      }
      this.options.onBatch?.(result);
      this.emit();
    }
    this.notAttempted = batches.slice(next).flatMap((batch) => batch.targets);
    this.phase = 'done';
    this.emit();
    this.settle(this.snapshot());
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }
}
