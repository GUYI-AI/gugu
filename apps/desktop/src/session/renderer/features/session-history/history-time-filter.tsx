import { useState } from 'react';
import { formatDate } from '@/i18n/format';
import { ChevronDown, Clock } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { timeCutoff, type HistoryTimeFilter } from './history-selection';

const PRESET_LABEL: Record<7 | 30 | 90, SessionMessageLookupKey> = {
  7: 'sessionHistory.timeWeek',
  30: 'sessionHistory.timeMonth',
  90: 'sessionHistory.timeQuarter',
};

/** 时间筛选生效时的说法(「一个月前」「2026年11月1日以前」);不限为 null。底部条、归档框标题都用它。 */
export function timeFilterLabel(
  filter: HistoryTimeFilter,
  translate: (key: SessionMessageLookupKey, values?: SessionMessageValues) => string,
  locale: string
): string | null {
  if (filter.kind === 'any') return null;
  if (filter.kind === 'days') return translate(PRESET_LABEL[filter.days]);
  const at = timeCutoff(filter, Date.now());
  if (at === undefined) return null;
  return translate('sessionHistory.timeBeforeDate', { date: formatDate(at, { year: 'numeric', month: 'long', day: 'numeric' }, locale) });
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 筛选栏「时间」(设计稿第 2 稿):最后更新在这之前 —— 不限 / 一周前 / 一个月前 / 三个月前 / 自定义日期。
 * 与来源、状态、关键词、节头勾选叠加。生效时触发钮写着那一档、描一道边(第 2 稿 .fbtn.set)。
 */
export function HistoryTimeFilterButton({ value, onChange }: { value: HistoryTimeFilter; onChange: (next: HistoryTimeFilter) => void }) {
  const { translate, locale } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const label = timeFilterLabel(value, translate, locale);
  const pick = (next: HistoryTimeFilter) => {
    onChange(next);
    setOpen(false);
  };
  const item = (on: boolean, text: string, onClick: () => void, testId: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className="flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground outline-none hover:bg-row-hover focus-visible:bg-row-hover"
      onClick={onClick}
      data-testid={testId}
    >
      <span className="flex w-4 justify-center">{on ? <i className="size-1.5 rounded-full bg-foreground" /> : null}</span>
      {text}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className={cn('w-[132px] justify-start font-normal text-foreground', value.kind !== 'any' && 'border-foreground')}
            data-testid="session-history-time"
          />
        }
      >
        <Clock className="size-4 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-left">{label ?? translate('sessionHistory.time')}</span>
        <ChevronDown className="size-4 text-foreground-muted" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-0 p-1" data-testid="session-history-time-menu">
        <div className="px-2 pt-1 pb-1 text-xs text-foreground-muted">{translate('sessionHistory.timeHeading')}</div>
        {item(value.kind === 'any', translate('sessionHistory.timeAny'), () => pick({ kind: 'any' }), 'session-history-time-any')}
        {([7, 30, 90] as const).map((days) =>
          item(
            value.kind === 'days' && value.days === days,
            translate(PRESET_LABEL[days]),
            () => pick({ kind: 'days', days }),
            `session-history-time-${days}`
          )
        )}
        <div className="-mx-1 my-1 h-px bg-border" />
        <label className="flex h-[30px] items-center gap-2 rounded-md px-2 text-sm text-foreground">
          <span className="flex w-4 justify-center">{value.kind === 'date' ? <i className="size-1.5 rounded-full bg-foreground" /> : null}</span>
          {translate('sessionHistory.timeCustom')}
          <input
            type="date"
            max={today()}
            value={value.kind === 'date' ? value.date : ''}
            className="ml-auto h-6 rounded-md border border-border-1 bg-background px-1 text-xs text-foreground"
            onChange={(event) => {
              if (event.target.value) pick({ kind: 'date', date: event.target.value });
            }}
            data-testid="session-history-time-date"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}
