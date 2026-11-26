import { Fragment } from 'react';
import { X } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { HISTORY_BATCH_SIZE } from './history-batch-job';
import { HistoryCheckbox } from './history-checkbox';
import { bulkModeOf, countSelection, selectionLabel, type BulkActionId, type HistorySelection } from './history-selection';
import type { HistoryJob } from './use-history-bulk';

const ACTION_LABEL: Record<BulkActionId, SessionMessageLookupKey> = {
  archive: 'sessionHistory.bulkArchive',
  restore: 'sessionHistory.bulkRestore',
  delete: 'sessionHistory.bulkDelete',
};

const JOB_LABEL: Record<HistoryJob['kind'], SessionMessageLookupKey> = {
  delete: 'sessionHistory.jobDeleting',
  restore: 'sessionHistory.jobRestoring',
  archive: 'sessionHistory.jobArchiving',
};

/**
 * 底部操作条(设计稿第 2 稿 .bulk):选了东西才出现,浮在列表底部正中,高 44、圆角 12、浮层阴影。
 * 两种样子 ——
 *  · 选择:✕(清除,Esc)、三态勾选框 + 「已选 N 条」、「选中筛选出的全部 N 条（一个月前）」,右侧按状态给动作:
 *    活跃 → 归档;已归档 → 恢复 | 永久删除;混着选 → 不给动作,写「其中 N 条已归档…」+ 两个收窄按钮。
 *  · 批量在跑(超过一批):「正在删除 120 / 300」+ 进度线 + 「每批 50 条…」+ 停止。
 */
export function SessionHistoryBulkBar({
  selection,
  total,
  timeLabel,
  job,
  onClear,
  onSelectAll,
  onKeepOnly,
  onAction,
  onStop,
}: {
  selection: HistorySelection;
  /** 当前筛选下能勾的一共几条;还没数出来是 null(先不给「全部」那个链接)。 */
  total: number | null;
  timeLabel: string | null;
  job: HistoryJob | null;
  onClear: () => void;
  onSelectAll: () => void;
  onKeepOnly: (status: 'active' | 'archived') => void;
  onAction: (action: BulkActionId) => void;
  onStop: (id: number) => void;
}) {
  const { translate } = useSessionMessages();
  const counts = countSelection(selection);
  const mode = bulkModeOf(counts);
  const visible = job !== null || mode.kind !== 'none';
  const label = selectionLabel(selection, total);
  return (
    <div className="pointer-events-none sticky bottom-6 z-10 mt-6 flex justify-center">
      <div
        role="toolbar"
        aria-label={translate('sessionHistory.bulkToolbar')}
        data-testid="session-history-bulk"
        data-mode={job ? 'job' : mode.kind}
        aria-hidden={!visible}
        className={cn(
          'flex h-11 items-center gap-1 rounded-xl bg-background-quaternary pr-1 pl-2 text-sm whitespace-nowrap shadow-lift transition-[opacity,transform] duration-150',
          visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
          job && 'gap-2 pr-2 pl-3'
        )}
      >
        {job ? (
          <>
            <Spinner size="sm" />
            <span className="px-1 text-foreground" data-testid="session-history-job-progress">
              {translate(JOB_LABEL[job.kind])}{' '}
              <b className="font-semibold tabular-nums">
                {job.processed} / {job.total}
              </b>
            </span>
            <span className="h-1 w-40 overflow-hidden rounded-full bg-border-1" aria-hidden>
              {/* 进度走 transform(❌ 动 width:每一帧重排) */}
              <i
                className="block h-full origin-left bg-foreground transition-transform duration-300"
                style={{ transform: `scaleX(${Math.min(1, job.processed / Math.max(1, job.total))})` }}
              />
            </span>
            <span className="px-2 text-xs text-foreground-muted">
              {translate(job.kind === 'delete' ? 'sessionHistory.jobNoteDelete' : 'sessionHistory.jobNote', { count: HISTORY_BATCH_SIZE })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={job.stopping}
              onClick={() => onStop(job.id)}
              data-testid="session-history-job-stop"
            >
              {translate('sessionHistory.jobStop')}
            </Button>
          </>
        ) : mode.kind === 'none' ? null : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-foreground-muted"
              aria-label={translate('sessionHistory.bulkClear')}
              title={translate('sessionHistory.bulkClear')}
              onClick={onClear}
              data-testid="session-history-bulk-clear"
            >
              <X className="size-4" />
            </Button>
            <span className="flex items-center gap-2 pr-2 pl-1 text-foreground" data-testid="session-history-bulk-count">
              <HistoryCheckbox
                state={label.allSelected ? 'on' : 'mixed'}
                label={translate(label.allSelected ? 'sessionHistory.bulkClear' : 'sessionHistory.bulkSelectAll', { count: total ?? label.count })}
                onClick={label.allSelected ? onClear : onSelectAll}
                testId="session-history-bulk-check"
              />
              {label.acrossLabel
                ? translate('sessionHistory.bulkSelectedAll', { count: label.count })
                : translate('sessionHistory.bulkSelected', { count: label.count })}
            </span>
            {label.offerAll !== null ? (
              <button
                type="button"
                className="px-2 text-foreground-muted underline decoration-border-1 underline-offset-[3px] hover:text-foreground"
                onClick={onSelectAll}
                data-testid="session-history-bulk-all"
              >
                {timeLabel
                  ? translate('sessionHistory.bulkSelectAllTime', { count: label.offerAll, time: timeLabel })
                  : translate('sessionHistory.bulkSelectAll', { count: label.offerAll })}
              </button>
            ) : null}
            <span className="w-5" />
            {mode.kind === 'mixed' ? (
              <>
                <span className="px-2 text-xs text-foreground-muted" data-testid="session-history-bulk-mixed">
                  {translate('sessionHistory.bulkMixedNote', { count: mode.archived })}
                </span>
                <Button variant="outline" size="sm" className="ml-1" onClick={() => onKeepOnly('active')} data-testid="session-history-bulk-keep-active">
                  {translate('sessionHistory.bulkKeepActive', { count: mode.active })}
                </Button>
                <Button variant="outline" size="sm" className="ml-1" onClick={() => onKeepOnly('archived')} data-testid="session-history-bulk-keep-archived">
                  {translate('sessionHistory.bulkKeepArchived', { count: mode.archived })}
                </Button>
              </>
            ) : (
              mode.actions.map((action, index) => (
                <Fragment key={action}>
                  {/* 永久删除与可撤销的动作之间隔一道(第 2 稿 .bulk .div)。 */}
                  {action === 'delete' && index > 0 ? <span className="mx-2 h-5 w-px bg-border-1" aria-hidden /> : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={action === 'delete' ? 'text-foreground-destructive' : 'text-foreground'}
                    onClick={() => onAction(action)}
                    data-testid={`session-history-bulk-${action}`}
                  >
                    {translate(ACTION_LABEL[action])}
                  </Button>
                </Fragment>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
