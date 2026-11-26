import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { confirmArchive } from '@renderer/features/sessions/archive-session-flow';
import { tellChildrenNotReached } from '@renderer/features/sessions/children-not-reached';
import { leaveSessionView } from '@renderer/features/sessions/leave-session-view';
import {
  PERMANENT_DELETE_BATCH_MAX,
  PERMANENT_DELETE_UNDO_MS,
  PermanentDeleteRun,
  type DeleteFailureReason,
  type PermanentDeleteSnapshot,
  type PermanentDeleteTarget,
} from '@renderer/features/sessions/permanent-delete-flow';
import { restoreArchivedSession } from '@renderer/features/sessions/restore-session-flow';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpcOn } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import type { ArchiveOutcome } from '@shared/core/sessions/sessions';
import { HISTORY_BATCH_SIZE, HistoryBatchJob, type BatchFailure } from './history-batch-job';
import {
  EMPTY_SELECTION,
  addRows,
  archiveScopeOf,
  keepOnly,
  removeRows,
  targetsOf,
  toggleRow,
  type BulkActionId,
  type BulkStatus,
  type HistorySelection,
  type SelectedSession,
} from './history-selection';
import { UndoCountdownNotice, type UndoCountdownControl } from './undo-countdown-notice';
import { undoNoticeClock } from './undo-notice-clock';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

export type HistoryJobKind = 'delete' | 'archive' | 'restore';
/** 底部条上那一条进度(超过一批才有):「正在删除 120 / 300」+ 停止。 */
export type HistoryJob = { id: number; kind: HistoryJobKind; processed: number; total: number; stopping: boolean };

/** 已经从列表里收起的行(等着删、正在删):它在哪一节、什么状态 —— 节头的数照它减。 */
export type HiddenRow = { sectionKey: string; status: BulkStatus };

/** 一台机器的会话在那台机器上做(rpcOn 本机写 null)。 */
function machineArg(machine: string): string | null {
  return machine === LOCAL_IMPORT_DEVICE ? null : machine;
}

/**
 * 没做成的原因:永久删除按回执的闭集(B 的 PermanentDeleteFailure + 回执没提到 / 整批调不通);归档 / 恢复只有
 * 「出了错」一种(原文进日志)。每一种一句译好的话 —— 按 Record 列全,回执多一种原因这里编译不过。离线另看机器在不在线。
 */
type FailureCode = DeleteFailureReason | 'action_failed';
const WHY_KEY: Record<FailureCode, SessionMessageLookupKey> = {
  not_found: 'sessionHistory.whyNotFound',
  not_archived: 'sessionHistory.whyNotArchived',
  cloud_unconfirmed: 'sessionHistory.whyCloudUnconfirmed',
  restored: 'sessionHistory.whyRestored',
  failed: 'sessionHistory.whyLocalFailed',
  no_receipt: 'sessionHistory.whyNoReceipt',
  unreachable: 'sessionHistory.whyUnreachable',
  action_failed: 'sessionHistory.whyFailedOn',
};
const logActionFailure = (error: unknown): string => {
  log.warn('session history archive or restore: a session was not done', { error: String(error) });
  return 'action_failed';
};

const UNDO_NOTICE_KEY = 'session-history-permanent-delete';
/** 撤销提示的停留远长于撤销窗口(窗口说了算,到点由 beforeDelete 收;两头怎么同步见 undo-notice-clock),也就不长关闭钮。 */
const UNDO_NOTICE_DWELL_MS = 10 * 60 * 1000;
/** 「撤销」要留够看见并点到的时间(与归档的撤销同一档)。 */
const UNDO_DWELL_MS = 8000;

/**
 * 会话历史的批量操作:选择、收起正在删的行、跑批量(永久删除 / 归档 / 恢复)、进度、停止、失败重试、撤销
 * (设计稿第 2 稿行为表)。界面只照它给的状态画;动作都落在行所在的那台机器上。
 */
export function useHistoryBulk(deps: {
  translate: Translate;
  labelOf: (machine: string) => string;
  isOnline: (machine: string) => boolean;
  /** 重读列表(全部机器);批量跑完 / 每批之后叫一次。 */
  refresh: () => Promise<void> | void;
  sectionLabel: (sectionKey: string) => string;
  /** 这一节在当前筛选下能勾的活跃会话一共几条(归档框标题「归档 gugu 项目里的…」)。 */
  sectionActive: (sectionKey: string) => number;
  timeLabel: string | null;
  /** 刚收起了这几行:展开着的节由调用方补上同样多的下一批(第 2 稿删掉一条,下面的顶上来)。 */
  onHidden: (rows: readonly SelectedSession[]) => void;
}) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [selection, setSelection] = useState<HistorySelection>(EMPTY_SELECTION);
  const [hidden, setHidden] = useState<ReadonlyMap<string, HiddenRow>>(() => new Map());
  const [jobs, setJobs] = useState<readonly HistoryJob[]>([]);
  /** 正在跑的批量里的行:不能再勾(第 2 稿「正在删的行不能再勾」)。 */
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** 有批量在跑:各台机器每收一条都发一次 session:changed,跑的时候由这里每批重读一次,❌ 跟着事件重读几百次。 */
  const busyCount = useRef(0);
  const pendingDelete = useRef<PermanentDeleteRun | null>(null);
  const jobControls = useRef(new Map<number, { stop: () => void }>());
  const jobSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 离开页面不等于撤销:还在撤销窗口里的那一次照旧到点删(提示条在全 app 的出口上,还看得见、还能撤)。
    };
  }, []);

  const t = (key: SessionMessageLookupKey, values?: SessionMessageValues) => depsRef.current.translate(key, values);

  const markBusy = (keys: readonly string[], on: boolean) => {
    busyCount.current += on ? 1 : -1;
    setBusyKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const hide = (rows: readonly SelectedSession[]) =>
    setHidden((current) => {
      const next = new Map(current);
      for (const row of rows) next.set(row.key, { sectionKey: row.sectionKey, status: row.status });
      return next;
    });
  const unhide = (keys: Iterable<string>) =>
    setHidden((current) => {
      const next = new Map(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  const startJob = (kind: HistoryJobKind, total: number, stop: () => void): number => {
    const id = ++jobSeq.current;
    jobControls.current.set(id, { stop });
    setJobs((current) => [...current, { id, kind, processed: 0, total, stopping: false }]);
    return id;
  };
  const updateJob = (id: number, patch: Partial<HistoryJob>) =>
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  const endJob = (id: number) => {
    jobControls.current.delete(id);
    setJobs((current) => current.filter((job) => job.id !== id));
  };

  /**
   * 没做成的那几条说成一句:在哪台、为什么(WHY_KEY 那一句;那台离线就说离线)。异常原文只进日志,❌ 端给用户(user-copy-leak)。
   */
  const whyOf = (row: SelectedSession, code: FailureCode): string => {
    const device = depsRef.current.labelOf(row.machine);
    if (!depsRef.current.isOnline(row.machine)) return t('sessionHistory.whyOffline', { device });
    return t(WHY_KEY[code], { device });
  };
  const failureText = (kind: HistoryJobKind, notDone: Array<{ row: SelectedSession; code: FailureCode }>, ok: number): string => {
    const { labelOf, isOnline } = depsRef.current;
    const machines = [...new Set(notDone.map(({ row }) => row.machine))];
    const offline = machines.length === 1 && !isOnline(machines[0]);
    if (kind === 'delete' && notDone.length === 1 && ok === 0) {
      const { row, code } = notDone[0];
      return offline
        ? t('sessionHistory.failedOneOffline', { title: row.title, device: labelOf(row.machine) })
        : t('sessionHistory.failedOne', { title: row.title, why: whyOf(row, code) });
    }
    if (kind === 'delete' && offline) return t('sessionHistory.failedDeletedRestOffline', { count: ok, device: labelOf(machines[0]) });
    const why = [...new Set(notDone.map(({ row, code }) => whyOf(row, code)))].slice(0, 3).join(t('sessionHistory.countSeparator'));
    const key: SessionMessageLookupKey =
      kind === 'delete'
        ? 'sessionHistory.failedDeletedRest'
        : kind === 'restore'
          ? 'sessionHistory.failedRestoredRest'
          : 'sessionHistory.failedArchivedRest';
    return t(key, { count: ok, why });
  };

  // ── 永久删除 ────────────────────────────────────────────────────────────────

  const toTarget = (row: SelectedSession): PermanentDeleteTarget => ({
    key: row.key,
    machine: machineArg(row.machine),
    projectId: row.projectId,
    sessionId: row.sessionId,
  });

  const runDelete = (rows: readonly SelectedSession[], mode: 'first' | 'retry') => {
    // 又开了一次删除:上一次还在撤销窗口里的那一次不再等,现在就删(第 2 稿 commitPending)。
    pendingDelete.current?.commitNow();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    hide(rows);
    depsRef.current.onHidden(rows);
    setSelection((current) => removeRows(current, byKey.keys()));
    const many = rows.length > PERMANENT_DELETE_BATCH_MAX;
    let jobId: number | null = null;
    let busy = false;
    const listeners = new Set<(paused: boolean) => void>();
    const enterDeleting = () => {
      if (busy) return;
      busy = true;
      markBusy([...byKey.keys()], true);
      if (pendingDelete.current === run) pendingDelete.current = null;
      if (many) jobId = startJob('delete', rows.length, () => run.stop());
    };
    const onChange = (snapshot: PermanentDeleteSnapshot) => {
      if (snapshot.phase === 'undo') {
        for (const listener of listeners) listener(snapshot.undoPaused);
        return;
      }
      if (snapshot.phase === 'deleting' || snapshot.phase === 'stopping') {
        enterDeleting();
        if (jobId !== null) updateJob(jobId, { processed: snapshot.processed, stopping: snapshot.phase === 'stopping' });
      }
    };
    const noticeClock = undoNoticeClock(UNDO_NOTICE_KEY, () => run);
    const run = new PermanentDeleteRun({
      targets: rows.map(toTarget),
      withChildren: false,
      undoMs: mode === 'retry' ? 0 : PERMANENT_DELETE_UNDO_MS,
      deleteOn: (machine, targets, options) => rpcOn(machine).sessions.permanentlyDeleteSessions(targets, options),
      // 回执里没提到的行:那台机器没说删没删,照「没删成」放回;别的原因走统一的人话出口。
      onCallFailed: (machine, error) =>
        log.warn('session history permanent delete: a batch call failed', { machine, error: String(error) }),
      onChange,
      // 窗口过了先收干净带「撤销」的提示,离开屏幕后才发第一批(重试没有提示,不用等)。
      beforeDelete: mode === 'first' ? noticeClock.beforeDelete : undefined,
    });
    if (mode === 'first') {
      pendingDelete.current = run;
      const control: UndoCountdownControl = {
        totalMs: PERMANENT_DELETE_UNDO_MS,
        remainingMs: () => run.snapshot().undoRemainingMs,
        pause: (reason) => run.pauseUndo(reason),
        resume: (reason) => run.resumeUndo(reason),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const one = rows.length === 1;
      toast({
        key: UNDO_NOTICE_KEY,
        title: one
          ? t('sessionHistory.deletedOne', { title: rows[0].title })
          : many
            ? t('sessionHistory.deleteScheduled', { count: rows.length })
            : t('sessionHistory.deletedMany', { count: rows.length }),
        description: createElement(UndoCountdownNotice, {
          text: many
            ? t('sessionHistory.deleteScheduledDesc', { count: PERMANENT_DELETE_BATCH_MAX })
            : t('sessionHistory.deletedDesc'),
          control,
        }),
        duration: UNDO_NOTICE_DWELL_MS,
        ...noticeClock.notice,
        action: {
          label: t('sessionHistory.undo'),
          onClick: () => {
            if (!run.undo()) return;
            if (pendingDelete.current === run) pendingDelete.current = null;
            unhide(byKey.keys());
            toast({ title: t('sessionHistory.backInArchived') });
          },
        },
      });
    }
    void run.finished.then(async (end) => {
      if (end.phase === 'undone') return;
      if (busy) markBusy([...byKey.keys()], false);
      if (jobId !== null) endJob(jobId);
      const back = [...end.failed.map((failure) => failure.key), ...end.notAttempted.map((target) => target.key)];
      unhide(back);
      tellChildrenNotReached([...end.unreached]);
      await depsRef.current.refresh();
      const failed = end.failed.map((failure) => ({ row: byKey.get(failure.key)!, code: failure.reason }));
      if (failed.length > 0) {
        const text = failureText('delete', failed, end.deletedCount);
        toast({
          title: t('sessionHistory.failedDeleted', { count: failed.length }),
          description: text,
          variant: 'destructive',
          duration: Infinity,
          action: { label: t('common.retry'), onClick: () => runDelete(failed.map(({ row }) => row), 'retry') },
        });
      } else if (end.notAttempted.length > 0) {
        toast({
          title: t('sessionHistory.stoppedDeleted', { count: end.deletedCount }),
          description: t('sessionHistory.untouchedArchived', { count: end.notAttempted.length }),
        });
      } else if (mode === 'retry') {
        toast({ title: t('sessionHistory.deletedMany', { count: end.deletedCount }), description: t('sessionHistory.retrySucceeded') });
      } else if (many) {
        toast({ title: t('sessionHistory.deletedMany', { count: end.deletedCount }), description: t('sessionHistory.groupMessagesStay') });
      }
      // 删掉的那几条不再回来(主进程那边已经没有了):重读回来之后它们本来就不在,收起的记号随之放掉。
      unhide(byKey.keys());
    });
    run.start();
  };

  // ── 归档 / 恢复(每条一次调用,超过一批出进度)────────────────────────────────

  const runBatch = <R,>(
    kind: 'archive' | 'restore',
    rows: readonly SelectedSession[],
    runOne: (row: SelectedSession) => Promise<R>,
    finish: (result: { done: SelectedSession[]; doneResults: R[]; failed: Array<BatchFailure<SelectedSession>>; notAttempted: SelectedSession[] }) => void
  ) => {
    const keys = rows.map((row) => row.key);
    setSelection((current) => removeRows(current, keys));
    markBusy(keys, true);
    const many = rows.length > HISTORY_BATCH_SIZE;
    let jobId: number | null = null;
    const job = new HistoryBatchJob(rows, runOne, {
      describeError: logActionFailure,
      onBatch: ({ processed }) => {
        if (jobId === null) return;
        updateJob(jobId, { processed });
        void depsRef.current.refresh();
      },
    });
    if (many) jobId = startJob(kind, rows.length, () => {
      job.stop();
      if (jobId !== null) updateJob(jobId, { stopping: true });
    });
    void job.run().then(async (result) => {
      markBusy(keys, false);
      if (jobId !== null) endJob(jobId);
      await depsRef.current.refresh();
      finish({
        done: result.done.map(({ item }) => item),
        doneResults: result.done.map(({ result: value }) => value),
        failed: result.failed,
        notAttempted: result.notAttempted,
      });
    });
  };

  const archiveRows = (rows: readonly SelectedSession[], removeSocialIdentity: boolean, undoable: boolean) =>
    runBatch<ArchiveOutcome>(
      'archive',
      rows,
      async (row) => {
        const outcome = await rpcOn(machineArg(row.machine)).sessions.archiveSession(row.projectId, row.sessionId, {
          withChildren: false,
          removeSocialIdentity,
        });
        // 归档掉正开着的那条,屏上那一块跟着收(与 archiveSessionNow 同一步)。
        for (const ref of outcome.archived) leaveSessionView(ref.projectId, ref.sessionId);
        return outcome;
      },
      ({ done, failed, notAttempted }) => {
        const archived = done.map((row) => ({ ...row, status: 'archived' as const }));
        if (failed.length > 0) {
          const text = failureText('archive', failed.map((failure) => ({ row: failure.item, code: 'action_failed' as const })), done.length);
          toast({
            title: t('sessionHistory.failedArchived', { count: failed.length }),
            description: text,
            variant: 'destructive',
            duration: Infinity,
            action: { label: t('common.retry'), onClick: () => archiveRows(failed.map(({ item }) => item), removeSocialIdentity, undoable) },
          });
        } else if (notAttempted.length > 0) {
          toast({
            title: t('sessionHistory.stoppedArchived', { count: done.length }),
            description: t('sessionHistory.untouchedActive', { count: notAttempted.length }),
          });
        } else if (undoable) {
          toast({
            title: done.length === 1 ? t('task.archivedToast') : t('sessionHistory.archivedMany', { count: done.length }),
            duration: UNDO_DWELL_MS,
            action: {
              label: t('sessionHistory.undo'),
              onClick: () => restoreRows(archived, false, () => toast({ title: t('sessionHistory.archiveUndone') })),
            },
          });
        } else {
          toast({ title: t('sessionHistory.backInArchived') });
        }
      }
    );

  const restoreRows = (rows: readonly SelectedSession[], undoable: boolean, onUndone?: () => void) => {
    // 别的机器上的会话:先把那台的项目挂上(会话 id 是这台从那台的应答里记下的,恢复按它自己选线)。
    const synced = new Map<string, Promise<void>>();
    const syncOnce = (machine: string) => {
      const deviceId = machineArg(machine);
      if (!deviceId) return Promise.resolve();
      let pending = synced.get(deviceId);
      if (!pending) {
        pending = Promise.resolve(remoteHostsStore.syncProjects(deviceId)).then(() => undefined);
        synced.set(deviceId, pending);
      }
      return pending;
    };
    runBatch(
      'restore',
      rows,
      async (row) => {
        await syncOnce(row.machine);
        return restoreArchivedSession({ projectId: row.projectId, sessionId: row.sessionId });
      },
      ({ done, failed, notAttempted }) => {
        const restored = done.map((row) => ({ ...row, status: 'active' as const }));
        if (failed.length > 0) {
          const text = failureText('restore', failed.map((failure) => ({ row: failure.item, code: 'action_failed' as const })), done.length);
          toast({
            title: t('sessionHistory.failedRestored', { count: failed.length }),
            description: text,
            variant: 'destructive',
            duration: Infinity,
            action: { label: t('common.retry'), onClick: () => restoreRows(failed.map(({ item }) => item), undoable, onUndone) },
          });
        } else if (notAttempted.length > 0) {
          toast({
            title: t('sessionHistory.stoppedRestored', { count: done.length }),
            description: t('sessionHistory.untouchedArchived', { count: notAttempted.length }),
          });
        } else if (onUndone) {
          onUndone();
        } else if (undoable) {
          toast({
            title: done.length === 1 ? t('sessionHistory.restoredToast') : t('sessionHistory.restoredMany', { count: done.length }),
            duration: UNDO_DWELL_MS,
            action: { label: t('sessionHistory.undo'), onClick: () => archiveRows(restored, true, false) },
          });
        }
      }
    );
  };

  const requestArchive = (rows: readonly SelectedSession[]) => {
    const { sectionActive, sectionLabel, timeLabel } = depsRef.current;
    const scope = archiveScopeOf({ rows, sectionActive, sectionLabel, timeLabel, across: selection.across });
    const title =
      scope.kind === 'one'
        ? undefined
        : scope.kind === 'section'
          ? scope.time
            ? t('sessionHistory.archiveSectionTimeTitle', { count: scope.count, section: scope.section, time: scope.time })
            : t('sessionHistory.archiveSectionTitle', { count: scope.count, section: scope.section })
          : scope.kind === 'time'
            ? t('sessionHistory.archiveTimeTitle', { count: scope.count, time: scope.time })
            : t('sessionHistory.archiveCountTitle', { count: scope.count });
    confirmArchive({
      childCount: 0,
      title,
      confirmLabel: scope.kind === 'one' ? undefined : t('sessionHistory.archiveCountTitle', { count: rows.length }),
      proceed: (_withChildren, removeSocialIdentity) => archiveRows(rows, removeSocialIdentity, true),
    });
  };

  /** 一条:不问,直接删 + 8 秒撤销;两条以上:问一次,只写条数。 */
  const requestDelete = (rows: readonly SelectedSession[]) => {
    if (rows.length === 0) return;
    if (rows.length === 1) {
      runDelete(rows, 'first');
      return;
    }
    showModal('permanentDeleteSessionsModal', {
      count: rows.length,
      onSuccess: () => runDelete(rows, 'first'),
    });
  };

  /** 底部条上的动作:一项一个处理(加「移到项目」= 在 BULK_ACTIONS 加一项、在这里加一个分支)。 */
  const runAction = (action: BulkActionId) => {
    const rows = targetsOf(selection, action);
    if (rows.length === 0) return;
    if (action === 'archive') requestArchive(rows);
    else if (action === 'restore') restoreRows(rows, true);
    else requestDelete(rows);
  };

  const stopJob = (id: number) => jobControls.current.get(id)?.stop();

  const clear = useCallback(() => setSelection(EMPTY_SELECTION), []);

  return {
    selection,
    hidden,
    busyKeys,
    /** 最近开始、还在跑的那一条进度(底部条一次只画一条)。 */
    job: jobs.length > 0 ? jobs[jobs.length - 1] : null,
    /** 有批量在跑:列表别跟着 session:changed 重读(每批自己重读一次)。 */
    isBusy: () => busyCount.current > 0,
    toggle: (row: SelectedSession, visible: readonly SelectedSession[], shift: boolean) =>
      setSelection((current) => toggleRow(current, row, visible, shift)),
    add: (rows: readonly SelectedSession[], across = false) => setSelection((current) => addRows(current, rows, across)),
    remove: (keys: readonly string[]) => setSelection((current) => removeRows(current, keys)),
    keepOnly: (status: BulkStatus) => setSelection((current) => keepOnly(current, status)),
    clear,
    runAction,
    deleteOne: (row: SelectedSession) => requestDelete([row]),
    stopJob,
  };
}

export type HistoryBulk = ReturnType<typeof useHistoryBulk>;
