import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Button } from '../ui/Button'
import { SegmentedTabs } from '../ui/SegmentedTabs'

type Source = { key: string; label: string; count: number; picked: number }

function SourceCounts({ count, picked }: Pick<Source, 'count' | 'picked'>) {
  return <>
    {picked > 0 && <span className="text-[length:var(--font-caption)] text-[var(--primary)]">✓{picked}</span>}
    <span className="text-[length:var(--font-caption)] tabular-nums text-[var(--muted-fg)]">{count}</span>
  </>
}

export function MemberPickerSources({ items, value, onChange, mobile, underline, searching }: {
  items: Source[]
  value: string
  onChange: (key: string) => void
  mobile: boolean
  underline: boolean
  searching: boolean
}) {
  const { t } = useTranslation('contacts')
  if (mobile && underline) {
    return <div className="shrink-0 overflow-x-auto whitespace-nowrap !px-3">
      <div className="w-max min-w-full [&_.gg-segtab]:min-h-[var(--control-h-touch)]">
        <SegmentedTabs variant="underline" ariaLabel={t('memberPicker.sources')} value={value} onChange={onChange}
          items={items.map(({ key, label, count, picked }) => ({
            value: key, label, panelId: 'member-picker-list', testId: `member-picker-source-${key}`,
            marker: <SourceCounts count={count} picked={picked} />,
          }))} />
      </div>
    </div>
  }

  const buttons = items.map(({ key, label, count, picked }) => (
    <Button key={key} variant="option" size="sm" role="radio" aria-checked={value === key} data-picker-source={key} onClick={() => onChange(key)}
      className={cn('shrink-0 gap-2', mobile ? '!rounded-[var(--radius-capsule)]' : 'w-full justify-start !border-transparent', searching && count === 0 && 'text-[var(--muted-fg)]')}>
      <span className={cn(!mobile && 'min-w-0 flex-1 truncate text-left')}>{label}</span>
      <SourceCounts count={count} picked={picked} />
    </Button>
  ))
  return mobile
    ? <div role="radiogroup" className="flex shrink-0 gap-2 overflow-x-auto !px-3 !pb-2">{buttons}</div>
    : <nav role="radiogroup" className="flex w-[178px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border-subtle)] !p-2">{buttons}</nav>
}
