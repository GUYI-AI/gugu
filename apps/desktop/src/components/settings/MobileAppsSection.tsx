import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
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
import { installedExtensions, useInstalledApps } from '@renderer/features/extensions/installed-extensions'
import { refreshFailure, useReplica } from '@/lib/replica'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
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
import { PHONE_HOST, phoneMarketCatalog, phoneMarketRows, useOfferedVersions } from './phoneMarketPage'
import '@/session/renderer/index.css'
import './mobile-app-market.css'

const NO_DEVICES: readonly Device[] = []
const log = rendererLogger('settings/mobile-apps')

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
  const platform = mode === 'installed' ? 'phone' : 'desktop'
  const catalog = useReplica(phoneMarketCatalog, [platform])
  const entries = catalog.state === 'value' ? catalog.value.entries : null
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
  const installedReading = useInstalledApps(PHONE_HOST)
  const store = installedReading.state === 'value' ? installedReading.value : null
  // Unread, or read before and its read again failing (the list read stays drawn), or the phone's store unreadable: said with a retry.
  const unreadable = refreshFailure(installedReading) !== null || store?.unreadable != null
  const reloadInventory = () => {
    void phoneApps.reload().then(() => installedExtensions.refresh(PHONE_HOST), (error: unknown) => {
      log.error({ error: String(error) }, 'Phone Apps unreadable')
      setError(messageForUser(error))
    })
  }

  useEffect(() => {
    if (!appDetail || openedLink.current === appDetail) return
    if (openInstalledDetail && !store) return
    const installed = openInstalledDetail && !!store?.manifests.some(app => app.id === appDetail.extensionId)
    if (!installed && !entries) return
    openedLink.current = appDetail
    onHandledAppDetail?.()
    if (installed) {
      setManage(appDetail.extensionId)
      return
    }
    const item = entries && phoneMarketRows(entries, '').find(row => row.manifest.id === appDetail.extensionId)
    if (item) setDetail(item)
    else setError(translate('extensions.marketUnavailable'))
  }, [appDetail, entries, store, onHandledAppDetail, openInstalledDetail, translate])

  const closeDetail = () => {
    setDetail(null)
    if (marketFrom) setManage(marketFrom)
    else onCloseRequestedDetail?.()
    setMarketFrom(null)
  }
  const categories = (['all', ...MARKET_CATEGORIES, 'other'] as const).map(value => ({
    value, label: value === 'all' ? t('phoneMarket.all') : translate(`extensions.category.${value}`),
  }))
  const rows = entries && phoneMarketRows(entries, query)
    .filter(item => item.manifest.id !== ASSISTANT_APP_ID && (chip === 'all' || marketCategoryOf(item.manifest) === chip))

  return <>
    {unreadable && mode === 'installed' && <SettingsNote tone="danger" role="alert" data-testid="phone-apps-unreadable">
      {translate('extensions.loadFailed')} <Button onClick={reloadInventory}>{translate('extensions.retry')}</Button>
    </SettingsNote>}
    {mode === 'installed' && (store
      ? <AppsSection installed={store} offered={offered} onManage={setManage}
        assistant={installedAssistant} hideEmpty={hideInstalledEmpty} />
      : !unreadable ? <ShelfSkeleton label={translate('extensions.loading')} /> : null)}
    {mode === 'market' && <div className="phone-market" data-testid="phone-app-market">
      <PhoneMarketFilters<'all' | MarketCategory> search={t('phoneMarket.searchApps')} query={query} onQueryChange={setQuery}
        choices={categories} category={chip} onCategoryChange={setChip} />
      {rows ? <div>
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
      </div> : catalog.state === 'unknown' ? <ShelfSkeleton label={translate('extensions.loading')} /> : (
        <SettingsNote role="alert">{translate('extensions.marketUnavailable')}
          {catalog.state === 'error' && catalog.retry && <Button onClick={() => void catalog.retry?.()}>{translate('extensions.retry')}</Button>}
        </SettingsNote>
      )}
    </div>}
    {!detail && !manage && mode === 'detail' && !error && catalog.state !== 'error' && <ShelfSkeleton label={translate('extensions.loading')} />}
    {(error || mode === 'detail' && catalog.state === 'error' && !detail) && <SettingsNote role="alert" tone="danger">
      {error ?? translate('extensions.marketUnavailable')}
      {onCloseRequestedDetail && <Button onClick={() => { setError(null); onCloseRequestedDetail() }}>{translate('common.cancel')}</Button>}
    </SettingsNote>}
    {detail && <PhoneMarketAppDetail item={detail} devices={devices} onClose={closeDetail} fromSettings={marketFrom !== null} />}
    {manage && <PhoneAppManage extensionId={manage} updateVersion={offered.state === 'value' ? offered.value.offered[manage] : undefined}
      gone={offered.state === 'value' && offered.value.gone.includes(manage)}
      onClose={() => { setManage(null); onCloseRequestedDetail?.() }}
      onViewInMarket={() => {
        const item = entries && phoneMarketRows(entries, '').find(row => row.manifest.id === manage)
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
          lifecycle={{ kind: 'get' }} locale={locale} translate={translate} hostKey={PHONE_HOST}
          onOpenExternal={url => { window.open(url, '_blank', 'noopener,noreferrer') }}
          backLabel={fromSettings ? translate('extensions.appSettings') : undefined}
          onBack={onClose} onLifecycle={() => setChoosing(true)}
          targetSummary={<PhoneMarketInstallSummary rows={rows} />} />
      </SessionUiTheme>
    </div>
    {choosing && <PhoneMarketInstallSheet rows={rows} onClose={() => setChoosing(false)} />}
  </Sheet>
}
