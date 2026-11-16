import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchField } from '@/components/ui/SearchField'
import { registerLocaleNamespace } from '@/i18n/runtime'
import { matchesPhoneNavigationLabel } from './phone-navigation-context'
import './phone-navigation-picker.css'

registerLocaleNamespace('phoneNavigationPicker', {
  'zh-CN': { agents: '搜索智能体', topics: '搜索话题', clear: '清除搜索', noResults: '没有匹配结果' },
  'en-US': { agents: 'Search Agents', topics: 'Search topics', clear: 'Clear search', noResults: 'No matches' },
})

/** The sheet still owns its lifetime, focus policy and native navigation callbacks. */
export function PhoneNavigationPicker<T>({ kind, items, nameOf, ready = true, children }: {
  kind: 'agents' | 'topics'
  items: readonly T[]
  nameOf: (item: T) => string
  ready?: boolean
  children: (shown: readonly T[]) => ReactNode
}) {
  const { t } = useTranslation('phoneNavigationPicker')
  const [query, setQuery] = useState('')
  const shown = items.filter(item => matchesPhoneNavigationLabel(nameOf(item), query))
  return <div data-phone-navigation-picker={kind}>
    <div className="gg-phone-navigation-search">
      <SearchField value={query} onChange={event => setQuery(event.currentTarget.value)}
        placeholder={t(kind)} clearLabel={t('clear')} onClear={() => setQuery('')}
        data-testid={`phone-${kind}-search`} />
    </div>
    {children(shown)}
    {ready && query.trim() && shown.length === 0 && <p role="status" className="gg-phone-room-empty">{t('noResults')}</p>}
  </div>
}
