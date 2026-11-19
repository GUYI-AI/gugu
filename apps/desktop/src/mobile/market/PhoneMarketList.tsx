import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import './phone-market.css'

type Choice<T extends string> = { value: T; label: string }

export function PhoneMarketFilters<T extends string>({ search, query, onQueryChange, choices, category, onCategoryChange }: {
  search: string
  query: string
  onQueryChange(query: string): void
  choices: readonly Choice<T>[]
  category: T
  onCategoryChange(category: T): void
}) {
  const { t } = useTranslation('main')
  return <div className="phone-market-filters">
    <SearchField className="phone-market-search" value={query} placeholder={search}
      onValueChange={onQueryChange} clearLabel={t('phoneMarket.clearSearch')} onClear={() => onQueryChange('')} />
    <div className="phone-market-categories">
      <SegmentedTabs items={choices} value={category} onChange={onCategoryChange} ariaLabel={t('phoneMarket.categories')} />
    </div>
  </div>
}

export function PhoneMarketRow({ name, description, icon, onOpen, action, testId }: {
  name: string
  description?: string
  icon: ReactNode
  onOpen?: () => void
  action?: ReactNode
  testId: string
}) {
  const content = <>
    <span className="phone-market-icon">{icon}</span>
    <span className="phone-market-row-copy">
      <span>{name}</span>
      {description && <span className="phone-market-description">{description}</span>}
    </span>
  </>
  return <div className="phone-market-row" data-testid={testId}>
    {onOpen ? <Button variant="ghost" className="phone-market-row-main" onClick={onOpen}>{content}</Button>
      : <div className="phone-market-row-main">{content}</div>}
    {action}
  </div>
}

export function PhoneMarketAction({ label, name, onClick, disabled }: {
  label: string
  name: string
  onClick(): void
  disabled?: boolean
}) {
  return <Button variant="secondary" size="sm" className="phone-market-action" aria-label={`${label} ${name}`}
    onClick={onClick} disabled={disabled}>{label}</Button>
}
