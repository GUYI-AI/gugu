import { useEffect, useState } from 'react';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@renderer/lib/components/pagination';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { cn } from '@renderer/utils/utils';
import type { Automation } from '@shared/core/automations/automation';
import { RUN_PAGE_SIZE } from '../automation-replicas';
import { useAutomationRunCounts, useAutomationRunsPaginated, useRetryAutomationRuns } from '../use-automations';
import { AutomationRunRow } from './AutomationRunRow';

type FilterOption = 'all' | 'done' | 'failed' | 'skipped';

interface RunHistoryProps {
  automation: Automation;
}

export function RunHistory({ automation }: RunHistoryProps) {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<FilterOption>('all');
  const { translate } = useSessionMessages();
  const filters: { value: FilterOption; label: string }[] = [
    { value: 'all', label: translate('automations.filterAll') },
    { value: 'done', label: translate('automations.filterDone') },
    { value: 'failed', label: translate('automations.filterFailed') },
    { value: 'skipped', label: translate('automations.filterSkipped') },
  ];

  useEffect(() => {
    setPage(0);
  }, [automation.id, filter]);

  const runs = useAutomationRunsPaginated(automation.id, page, filter);
  const counts = useAutomationRunCounts(automation.id);
  const retry = useRetryAutomationRuns(automation.id);

  const historyRuns = runs.state === 'value' ? runs.value.slice(0, RUN_PAGE_SIZE) : null;
  const hasNextPage = runs.state === 'value' && runs.value.length > RUN_PAGE_SIZE;
  const hasPrevPage = page > 0;
  const failure = runs.state === 'error' ? runs.error : counts.state === 'error' ? counts.error
    : runs.state === 'value' && runs.error ? runs.error : counts.state === 'value' ? counts.error : null;

  return (
    <section className="flex h-full flex-col rounded-lg bg-background-1">
      <div className="flex w-full gap-1.5 border-b p-2">
        {filters.map(({ value, label }) => {
          return (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'flex items-center gap-1 w-full justify-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                filter === value
                  ? 'bg-background-2 text-foreground'
                  : 'text-foreground-muted hover:bg-row-hover active:bg-row-press hover:text-foreground'
              )}
            >
              {label}
              {counts.state === 'value' ? (
                <span
                  className={cn(
                    'tabular-nums',
                    filter === value ? 'text-foreground-muted' : 'text-foreground-passive'
                  )}
                >
                  {counts.value[value]}
                </span>
              ) : counts.state === 'unknown' ? (
                <Unknown className="w-6" />
              ) : null}
            </button>
          );
        })}
      </div>
      {failure ? <div className="px-2 pt-2"><RefreshFailed error={failure} onRetry={retry} /></div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {historyRuns === null ? (
          runs.state === 'unknown' ? (
            Array.from({ length: RUN_PAGE_SIZE }, (_, index) => (
              <div key={index} className="px-2 py-2">
                <Unknown className="h-[2lh] w-full" />
              </div>
            ))
          ) : null
        ) : historyRuns.length > 0 ? (
          <>
            {historyRuns.map((run) => (
              <AutomationRunRow
                key={run.id}
                run={run}
                projectId={automation.workspaceId ?? null}
                deliveredTo={automation.agentSessionId}
                deliveredToName={automation.agentSession?.name}
              />
            ))}
          </>
        ) : (
          <EmptyState
            label={translate('automations.runsEmpty')}
            className="h-full bg-transparent"
          />
        )}
      </div>
      <Pagination className="border-t py-1">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={hasPrevPage ? () => setPage((p) => p - 1) : undefined}
              aria-disabled={!hasPrevPage}
              className={!hasPrevPage ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>
          <PaginationItem>
            <span className="px-2 text-xs text-foreground-muted">
              {translate('automations.page', { page: page + 1 })}
            </span>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              onClick={hasNextPage ? () => setPage((p) => p + 1) : undefined}
              aria-disabled={!hasNextPage}
              className={!hasNextPage ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </section>
  );
}
