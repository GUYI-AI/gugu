import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchField } from '@/components/ui/SearchField'
import { registerLocaleNamespace } from '@/i18n/runtime'
import './phone-navigation-picker.css'

registerLocaleNamespace('phoneNavigationPicker', {
  'zh-CN': { agents: '搜索智能体', topics: '搜索话题', clear: '清除搜索', noResults: '没有匹配结果' },
  'en-US': { agents: 'Search agents', topics: 'Search topics', clear: 'Clear search', noResults: 'No matches' },
})

export function PhoneNavigationPicker<T>({ kind, items, nameOf, ready = true, children }: {
  kind: 'agents' | 'topics'
  items: readonly T[]
  nameOf: (item: T) => string
  ready?: boolean
  children: (shown: readonly T[]) => ReactNode
}) {
  const { t } = useTranslation('phoneNavigationPicker')
  const [query, setQuery] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const shown = items.filter(item => nameOf(item).toLocaleLowerCase().includes(term))
  return <div>
    <div className="gg-phone-navigation-search">
      <SearchField value={query} onValueChange={setQuery} placeholder={t(kind)}
        clearLabel={t('clear')} onClear={() => setQuery('')} data-testid={`phone-${kind}-search`} />
    </div>
    {children(shown)}
    {ready && term && !shown.length && <p role="status" className="gg-phone-room-empty">{t('noResults')}</p>}
  </div>
}
