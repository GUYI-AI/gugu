import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink'
import { PhoneMarketAction, PhoneMarketFilters, PhoneMarketRow } from '@/mobile/market/PhoneMarketList'
import { PhoneMarketInstallSheet, PhoneMarketInstallSummary } from '@/mobile/market/PhoneMarketInstallSheet'
import { usePhoneAppInstallTargets, usePhoneMarketInstalledAppIds } from '@/mobile/market/phoneMarketTargets'
import { useTheme } from '@/store/theme'
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram'
import { AppProductPage } from '@renderer/features/extensions/panel/app-product-page'
import { ShelfSkeleton } from '@renderer/features/extensions/panel/extension-skeletons'
import { installedExtensionsStore as store } from '@renderer/features/extensions/installed-extensions-store'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry'
import { MARKET_CATEGORIES, localizedManifestText, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog'
import type { MarketListItem } from '@shared/extensions/market'
import { phoneApps } from '../appSlot/phoneApps'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { SessionUiTheme } from '../sessionpage/SessionUiTheme'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from './SettingsPrimitives'
import { AppsSection } from './AppsSection'
import { PhoneAppManage } from './PhoneAppManage'
import { PHONE_MARKET_QUERY_KEY, phoneMarketRows, phoneProductApi, useOfferedVersions, usePhoneMarketPage } from './phoneMarketPage'
import '@/session/renderer/index.css'
import './mobile-app-market.css'

const NO_DEVICES: readonly Device[] = []

type Props = {
  mode: 'market' | 'installed' | 'detail'
  devices?: readonly Device[]
  appDetail?: ExtensionAppDetailLink
  openInstalledDetail?: boolean
  onHandledAppDetail?: () => void
  onCloseRequestedDetail?: () => void
  installedAssistant?: boolean
  hideInstalledEmpty?: boolean
}

/** Catalog reads and product details are shared with desktop; installed phone Apps keep the existing local management path. */
export const MobileAppsSection = observer(function MobileAppsSection({
  mode, devices = NO_DEVICES, appDetail, openInstalledDetail, onHandledAppDetail, onCloseRequestedDetail,
  installedAssistant, hideInstalledEmpty,
}: Props) {
  const { t } = useTranslation('main')
  const { translate, locale } = useSessionMessages()
  const client = useQueryClient()
  const catalog = usePhoneMarketPage(mode === 'installed' ? 'phone' : 'desktop')
  const offered = useOfferedVersions()
  const installedIds = usePhoneMarketInstalledAppIds(mode === 'market' ? devices : NO_DEVICES)
  const [manage, setManage] = useState<string | null>(null)
  // An App settings page takes a person back to the same device's settings after viewing its product page.
  const [marketFrom, setMarketFrom] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<'all' | MarketCategory>('all')
  const [detail, setDetail] = useState<MarketListItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openedLink = useRef<ExtensionAppDetailLink | undefined>(undefined)
  const inventory = useQuery({
    queryKey: ['phone-app-inventory'],
    queryFn: async () => {
      await phoneApps.ready()
      if (phoneApps.unreadable()) throw new Error('Unreadable phone App inventory')
      return true
    },
    retry: false,
  })
  const unreadable = inventory.isError
  const inventoryLoaded = store.isLoaded
  const reloadInventory = () => void phoneApps.reload().then(() => inventory.refetch(), () => inventory.refetch())
  useEffect(() => {
    const off = phoneApps.market.onRefreshed((result) => {
      if (result.outcome === 'changed') void client.invalidateQueries({ queryKey: PHONE_MARKET_QUERY_KEY })
    })
    void phoneApps.market.refresh()
    return off
  }, [client])

  useEffect(() => {
    if (!appDetail || openedLink.current === appDetail) return
    if (openInstalledDetail && !inventoryLoaded) return
    const installed = openInstalledDetail && store.manifests.some(app => app.id === appDetail.extensionId)
    if (!installed && !catalog.data) return
    openedLink.current = appDetail
    onHandledAppDetail?.()
    if (installed) {
      setManage(appDetail.extensionId)
      return
    }
    const item = phoneMarketRows(catalog.data?.entries ?? [], '').find(row => row.manifest.id === appDetail.extensionId)
    if (item) setDetail(item)
    else setError(translate('extensions.marketUnavailable'))
  }, [appDetail, catalog.data, onHandledAppDetail, openInstalledDetail, inventoryLoaded, translate])

  const closeDetail = () => {
    setDetail(null)
    if (marketFrom) setManage(marketFrom)
    else onCloseRequestedDetail?.()
    setMarketFrom(null)
  }
  const categories = (['all', ...MARKET_CATEGORIES, 'other'] as const).map(value => ({
    value, label: value === 'all' ? t('phoneMarket.all') : translate(`extensions.category.${value}`),
  }))
  const rows = phoneMarketRows(catalog.data?.entries ?? [], query)
    .filter(item => item.manifest.id !== ASSISTANT_APP_ID && (chip === 'all' || marketCategoryOf(item.manifest) === chip))

  return <>
    {unreadable && mode === 'installed' && <SettingsNote tone="danger" role="alert" data-testid="phone-apps-unreadable">
      {translate('extensions.loadFailed')} <Button onClick={reloadInventory}>{translate('extensions.retry')}</Button>
    </SettingsNote>}
    {mode === 'installed' && (inventoryLoaded
      ? <AppsSection updates={offered.updates} gone={offered.gone} known={offered.known} onManage={setManage}
        assistant={installedAssistant} hideEmpty={hideInstalledEmpty} />
      : !unreadable ? <ShelfSkeleton label={translate('extensions.loading')} /> : null)}
    {mode === 'market' && <div className="phone-market" data-testid="phone-app-market">
      <PhoneMarketFilters<'all' | MarketCategory> search={t('phoneMarket.searchApps')} query={query} onQueryChange={setQuery}
        choices={categories} category={chip} onCategoryChange={setChip} />
      {catalog.data ? <div>
        {rows.map(item => {
          const id = item.manifest.id
          const text = localizedManifestText(item.manifest, locale)
          const open = () => setDetail(item)
          return <PhoneMarketRow key={id} testId={`phone-market-app-${id}`} name={text.name} description={text.subtitle}
            icon={<ExtensionMonogram name={text.name} iconDataUrl={item.cloud.iconUrl} size="md" />} onOpen={open}
            action={installedIds.has(id) ? <span className="phone-market-status">{t('phoneMarket.installed')}</span>
              : <PhoneMarketAction label={t('phoneMarket.install')} name={text.name} onClick={open} />} />
        })}
        {!rows.length && <SettingsNote role="status">{t('phoneMarket.noResults')}</SettingsNote>}
      </div> : catalog.isPending ? <ShelfSkeleton label={translate('extensions.loading')} /> : (
        <SettingsNote role="alert">{translate('extensions.marketUnavailable')}
          <Button onClick={() => void catalog.refetch()}>{translate('extensions.retry')}</Button>
        </SettingsNote>
      )}
    </div>}
    {!detail && !manage && mode === 'detail' && !error && !catalog.isError && <ShelfSkeleton label={translate('extensions.loading')} />}
    {(error || mode === 'detail' && catalog.isError && !detail) && <SettingsNote role="alert" tone="danger">
      {error ?? translate('extensions.marketUnavailable')}
      {onCloseRequestedDetail && <Button onClick={() => { setError(null); onCloseRequestedDetail() }}>{translate('common.cancel')}</Button>}
    </SettingsNote>}
    {detail && <PhoneMarketAppDetail item={detail} devices={devices} onClose={closeDetail} fromSettings={marketFrom !== null} />}
    {manage && <PhoneAppManage extensionId={manage} updateVersion={offered.updates[manage]} gone={offered.gone.includes(manage)}
      onClose={() => { setManage(null); onCloseRequestedDetail?.() }}
      onViewInMarket={() => {
        const item = phoneMarketRows(catalog.data?.entries ?? [], '').find(row => row.manifest.id === manage)
        if (item) { setMarketFrom(manage); setDetail(item) }
        else setError(translate('extensions.marketUnavailable'))
        setManage(null)
      }} />}
  </>
})

function PhoneMarketAppDetail({ item, devices, onClose, fromSettings }: {
  item: MarketListItem
  devices: readonly Device[]
  onClose(): void
  fromSettings: boolean
}) {
  const { translate, locale } = useSessionMessages()
  const { theme } = useTheme()
  const [choosing, setChoosing] = useState(false)
  const rows = usePhoneAppInstallTargets(item.manifest.id, devices)
  const name = localizedManifestText(item.manifest, locale).name
  return <Sheet fullScreenMobile onClose={onClose} testId="phone-app-product" ariaLabel={name}>
    <div className={`${sessionSkinClassName(theme)} phone-app-product`}>
      <SessionUiTheme theme={theme} skin>
        <AppProductPage subject={{ manifest: item.manifest, cloud: item.cloud, installRef: item.ref }}
          lifecycle={{ kind: 'get' }} locale={locale} translate={translate} api={phoneProductApi}
          onOpenExternal={url => { window.open(url, '_blank', 'noopener,noreferrer') }}
          backLabel={fromSettings ? translate('extensions.appSettings') : undefined}
          onBack={onClose} onLifecycle={() => setChoosing(true)}
          targetSummary={<PhoneMarketInstallSummary rows={rows} />} />
      </SessionUiTheme>
    </div>
    {choosing && <PhoneMarketInstallSheet rows={rows} onClose={() => setChoosing(false)} />}
  </Sheet>
}
