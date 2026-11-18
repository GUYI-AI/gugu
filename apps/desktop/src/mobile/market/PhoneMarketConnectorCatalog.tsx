import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantConnectedApp } from '@/components/assistant/assistant-app-connections'
import { connectedAppsCatalog, type AppCategoryId } from '@/components/assistant/connected-app-catalog'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { PhoneMarketAction, PhoneMarketFilters, PhoneMarketRow } from './PhoneMarketList'

export type PhoneConnectorCatalogMode = 'market' | 'installed'

export function PhoneMarketConnectorCatalog({ apps, connectionKnown, mode, open, icon }: {
  apps: readonly AssistantConnectedApp[]
  connectionKnown: boolean
  mode: PhoneConnectorCatalogMode
  open?: (app: AssistantConnectedApp) => void
  icon: (app: AssistantConnectedApp, size: number) => ReactNode
}) {
  const { t, i18n } = useTranslation('main')
  const { t: assistant } = useTranslation('assistant')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | AppCategoryId>('all')
  const catalog = connectedAppsCatalog(apps, { tab: 'all', query: '', category: null }, i18n.language)
  const choices = [
    { value: 'all' as const, label: t('phoneMarket.all') },
    ...catalog.categories.map(group => ({ value: group.id, label: group.title })),
  ]
  const activeCategory = choices.some(choice => choice.value === category) ? category : 'all'
  const rows = connectedAppsCatalog(apps, {
    tab: mode === 'market' ? 'all' : 'mine', query, category: activeCategory === 'all' ? null : activeCategory,
  }, i18n.language).results
  if (mode === 'installed' && !connectionKnown) return <AppConnectionListPlaceholder />
  return <div className="phone-market" data-testid="phone-market-connectors">
    <PhoneMarketFilters search={t('phoneMarket.searchConnectors')} query={query} onQueryChange={setQuery}
      choices={choices} category={activeCategory} onCategoryChange={setCategory} />
    <div>
      {rows.map(app => <PhoneMarketRow key={app.id} name={app.name} description={app.description} icon={icon(app, 40)}
        testId={`phone-market-connector-${app.id}`} onOpen={open ? () => open(app) : undefined} action={
          app.state === 'connected'
            ? <span className="phone-market-status">{t('phoneMarket.connected')}</span>
            : app.saved || app.connectionStatus ? <span className="phone-market-status">
              {app.connectionStatus ?? assistant(`connectors.${app.state}`)}
            </span> : mode === 'market' && connectionKnown && open
              ? <PhoneMarketAction label={t('phoneMarket.connect')} name={app.name} onClick={() => open(app)} />
              : undefined
        } />)}
      {!rows.length && <SettingsNote role="status">{t(mode === 'installed' && !query.trim() ? 'phoneMarket.noInstalled' : 'phoneMarket.noResults')}</SettingsNote>}
    </div>
  </div>
}
