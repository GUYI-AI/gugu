import { messageForUser } from '@/lib/userFacingError';
import { followLink } from '../../lib/guguLinks'
import type { AppDetailLink } from '@gugu/core/shared/ui/guguLink'
import { useEffect, useRef, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { rendererLogger } from '@/lib/log'
import { useTheme } from '@/store/theme'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { SessionUiTheme } from '../sessionpage/SessionUiTheme'
import { queryClient, useReplica } from '@/lib/replica'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { AppMarketContent, AppMarketFirstScreen, type MarketBrowsePage } from '@/session/renderer/features/extensions/panel/app-market-content'
import { marketShelf } from '@/session/renderer/features/extensions/market-replicas'
import { AppProductPage } from '@/session/renderer/features/extensions/panel/app-product-page'
import { appLifecycle } from '@/session/renderer/features/extensions/panel/app-lifecycle'
import type { AppLifecycle } from '@/session/renderer/features/extensions/panel/app-lifecycle-button'
import { ShelfSkeleton } from '@/session/renderer/features/extensions/panel/extension-skeletons'
import type { ExtensionPendingAction } from '@/session/renderer/features/extensions/panel/extension-pending'
import { installedExtensions, useInstalledApps } from '@/session/renderer/features/extensions/installed-extensions'
import { MARKET_PAGE_SIZE, type MarketListItem, type MarketSourceRef } from '@/session/shared/extensions/market'
import { localizedManifestText, type MarketCategory } from '@/session/shared/extensions/catalog'
import { grantableBy } from '@/session/shared/extensions/attachment-install'
import { PHONE_CAPABILITY_SUPPORT } from '@/session/shared/extensions/app-platforms'
import { PHONE_CAPABILITIES, phoneApps } from '../appSlot/phoneApps'
import { phoneRuns } from '../appSlot/phoneAppHost'
import { Button } from '../ui/Button'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SearchField } from '../ui/SearchField'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from './SettingsPrimitives'
import { AppsSection } from './AppsSection'
import { PhoneAppManage } from './PhoneAppManage'
import { PHONE_HOST, phoneSearchRows, useOfferedVersions } from './phoneMarketPage'
import '@/session/renderer/index.css'
import './mobile-app-market.css'

const log = rendererLogger('settings/mobile-apps')

/** The phone supplies storage and actions; browsing and product pages are the desktop's components. */
export function MobileAppsSection({ appDetail }: { appDetail?: AppDetailLink }) {
  return <QueryClientProvider client={queryClient}><MobileAppsContent appDetail={appDetail} /></QueryClientProvider>
}

function MobileAppsContent({ appDetail }: { appDetail?: AppDetailLink }) {
  const { translate, locale } = useSessionMessages()
  const { theme } = useTheme()
  const skin = sessionSkinClassName(theme)
  // `marketShelf('phone', locale)`: kept in memory for the run; on a cold start its first screen is kept (the snapshot), drawn
  // until the shelf is read. A shelf drawn is replaced only once its featured pictures are decoded; one that cannot be read
  // keeps the drawn shelf (the reading says so).
  const shelfReading = useReplica(marketShelf, [PHONE_HOST, locale])
  const full = shelfReading.state === 'value' ? shelfReading.value.full ?? null : null
  const first = shelfReading.state === 'value' && !shelfReading.value.full ? shelfReading.value.first ?? null : null
  const shelfFailure = shelfReading.state === 'unknown' ? null : shelfReading.error
  const [tab, setTab] = useState<'market' | 'installed'>('market')
  const [view, setView] = useState<MarketBrowsePage>('market')
  const [manage, setManage] = useState<string | null>(null)
  // Asked for from an App's settings page: back from the market page returns there, as on the desktop.
  const [marketFrom, setMarketFrom] = useState<string | null>(null)
  const closeDetail = () => {
    setDetail(null)
    if (marketFrom) setManage(marketFrom)
    setMarketFrom(null)
  }
  const offered = useOfferedVersions()
  // What is installed here (`installedExtensions('phone')`; its read waits for the phone's App store index).
  const installedReading = useInstalledApps(PHONE_HOST)
  const store = installedReading.state === 'value' ? installedReading.value : null
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<'all' | MarketCategory>('all')
  const [pages, setPages] = useState(1)
  const [detail, setDetail] = useState<MarketListItem | null>(null)
  const [pending, setPending] = useState<Record<string, ExtensionPendingAction>>({})
  const inFlight = useRef(false)
  const [failed, setFailed] = useState<{ title: string; cause: string } | null>(null)
  const openedLink = useRef<AppDetailLink | undefined>(undefined)
  useEffect(() => {
    if (!appDetail || !full || !store || openedLink.current === appDetail) return
    openedLink.current = appDetail
    if (store.manifests.some((manifest) => manifest.id === appDetail.extensionId)) {
      setManage(appDetail.extensionId)
      return
    }
    const item = full.items.find(item => item.manifest.id === appDetail.extensionId)
    if (item) setDetail(item)
    else setFailed({ title: translate('extensions.marketUnavailable'), cause: appDetail.extensionId })
  }, [appDetail, full, store, translate])

  const sentinel = useRef<HTMLDivElement | null>(null)
  const retryShelf = () => void marketShelf.refresh(PHONE_HOST, locale)
  // Searched in the shelf as read (the phone has no search on a server); nothing to search while it is not read.
  const rows = full ? (query.trim() === '' ? full.items : phoneSearchRows(full.items, query.trim())) : null
  const hasMore = rows !== null && pages * MARKET_PAGE_SIZE < rows.length

  // The index could not be read whole (what can be read is drawn, nothing is changed), or the list could not be read at all.
  const unreadable = installedReading.state === 'error' || (installedReading.state === 'value' && installedReading.value.unreadable !== null)
  const readAgain = () => {
    void phoneApps.reload().then(() => installedExtensions.refresh(PHONE_HOST), (error: unknown) => {
      log.error({ error: String(error) }, 'Phone Apps unreadable')
      setFailed({ title: translate('extensions.loadFailed'), cause: messageForUser(error) })
    })
  }

  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || tab === 'installed') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setPages((count) => count + 1)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, pages, rows?.length, tab, view, query, chip])

  const lifecycleOf = (id: string, item: MarketListItem): AppLifecycle => {
    // The existing phone host decides whether it has a page; desktop-only host pages cannot be installed here.
    if (!phoneRuns(item.manifest) || item.manifest.contributes.tabs.some((entry) => entry.hostPage)) {
      return { kind: 'word', text: translate('extensions.needsDesktop') }
    }
    // What is installed not known yet: no button (null draws nothing), ❌ 「安装」 for an App that may be installed.
    if (!store) return null
    const installed = store.manifests.find((manifest) => manifest.id === id)
    return appLifecycle({ installed, enabled: store.isEnabled(id), offered: item, preinstalled: store.isPreinstalled(id), canOpen: Boolean(store.mainTabOf(id)) }, translate)
  }

  const change = async (id: string, action: ExtensionPendingAction | undefined, run: () => Promise<{ success: boolean; error?: string }>) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(action ? { [id]: action } : {})
    setFailed(null)
    const title = translate(action ? 'extensions.installFailed' : 'extensions.switchFailed')
    try {
      const result = await run()
      if (!result.success) {
        log.error({ id, error: result.error }, 'Phone App action failed')
        setFailed({ title, cause: messageForUser(result.error) })
      }
    } catch (error) {
      log.error({ id, error: String(error) }, 'Phone App action failed')
      setFailed({ title, cause: messageForUser(error) })
    } finally {
      inFlight.current = false
      setPending({})
    }
  }
  const install = (ref: MarketSourceRef) => void change(ref.extensionId, 'installing', () => phoneApps.installFromMarket({ ref }))
  const act = (item: MarketListItem) => {
    const id = item.manifest.id
    const state = lifecycleOf(id, item)
    if (state?.kind === 'get') install(item.ref)
    else if (state?.kind === 'update') install({ extensionId: id, version: state.version })
    else if (state?.kind === 'enable') void change(id, undefined, () => phoneApps.setEnabled(id, true))
    else if (state?.kind === 'open') {
      const kind = store?.mainTabOf(id)?.kind
      if (kind) void followLink({ kind: 'app', extensionId: item.manifest.id, tab: kind.slice(item.manifest.id.length + 1), path: '', query: {}, place: null })
    }
  }
  const error = failed ? <SettingsNote tone="danger" role="alert">{failed.title}<br />{failed.cause}</SettingsNote> : null
  const installed = detail && store ? store.manifests.find((manifest) => manifest.id === detail.manifest.id) : undefined

  return (
    <>
      <div className="phone-app-market-tabs"><SegmentedTabs value={tab} onChange={setTab} ariaLabel={translate('extensions.title')} items={[
        { value: 'market', label: translate('extensions.tabMarket'), testId: 'phone-apps-market-section' },
        { value: 'installed', label: translate('extensions.tabInstalled'), testId: 'phone-apps-installed-tab' },
      ]} /></div>
      {tab === 'market' ? <div className="phone-app-market-tabs"><SegmentedTabs value={view} onChange={setView} ariaLabel={translate('extensions.tabMarket')} items={[
        { value: 'market', label: translate('extensions.recommended'), testId: 'phone-apps-market-tab' },
        { value: 'newest', label: translate('extensions.newest'), testId: 'phone-apps-newest-tab' },
        { value: 'popular', label: translate('extensions.popular'), testId: 'phone-apps-popular-tab' },
        { value: 'all', label: translate('extensions.allApps'), testId: 'phone-apps-all-tab' },
      ]} /></div> : null}
      {unreadable ? (
        <SettingsNote tone="danger" role="alert" data-testid="phone-apps-unreadable">
          {translate('extensions.loadFailed')}
          <Button onClick={readAgain}>{translate('extensions.retry')}</Button>
        </SettingsNote>
      ) : null}
      {tab === 'installed' ? <AppsSection offered={offered} onManage={setManage} /> : (
        <div className={`${skin} mk phone-app-market`} data-testid="phone-app-market">
          <SearchField value={query} placeholder={translate('extensions.searchPlaceholder')} onChange={(event) => { setQuery(event.target.value); setPages(1) }} />
          {error}
          {/* 画着一份就一直画它:重读没读到(下载站连不上、精选底图取不到)不换成错误面板。 */}
          {full && rows ? (
            <AppMarketContent
              view={view} onRetry={retryShelf}
              shelf={{ status: 'ready', query, errorKind: null, items: rows.slice(0, pages * MARKET_PAGE_SIZE), total: rows.length, page: pages - 1, hasMore, loadingMore: false, invalid: [], featured: full.featured, home: full.home }}
              chip={chip} onChipChange={setChip}
              query={query.trim()} hostKey={PHONE_HOST}
              lifecycleOf={lifecycleOf} installedIds={store ? new Set(store.manifests.map((manifest) => manifest.id)) : null}
              pending={pending} downloadPercent={{}} onOpen={setDetail} onAction={act} sentinelRef={sentinel}
            />
          ) : <>
            {/* Not read (a cold start's first screen, or nothing): a failed read is said with a retry, ❌ the skeleton forever. */}
            {first && view === 'market' && chip === 'all' && query.trim() === '' ? (
              <AppMarketFirstScreen first={first} hostKey={PHONE_HOST} chip={chip} onChipChange={setChip} />
            ) : shelfFailure ? null : <ShelfSkeleton label={translate('extensions.loading')} />}
            {shelfFailure ? (
              <div className="mk-status" role="alert">
                {translate('extensions.marketUnavailable')}
                <Button onClick={retryShelf}>{translate('extensions.retry')}</Button>
              </div>
            ) : null}
          </>}
        </div>
      )}
      {detail ? (
        <Sheet fullScreenMobile onClose={closeDetail} testId="phone-app-product" ariaLabel={localizedManifestText(detail.manifest, locale).name}>
          <div className={`${skin} phone-app-product`}>
            <SessionUiTheme theme={theme} skin>
              {error}
              <AppProductPage
                key={detail.manifest.id}
                subject={{ manifest: grantableBy(detail.manifest, PHONE_CAPABILITIES), installedVersion: installed?.version, cloud: detail.cloud, installRef: detail.ref }}
                lifecycle={lifecycleOf(detail.manifest.id, detail)} pending={pending[detail.manifest.id]}
                locale={locale} translate={translate} hostKey={PHONE_HOST} onOpenExternal={(url) => { window.open(url, '_blank', 'noopener,noreferrer') }}
                backLabel={marketFrom ? translate('extensions.appSettings') : undefined}
                onBack={closeDetail} onLifecycle={() => act(detail)} onInstallVersion={install}
                onManage={installed && store && !store.isPreinstalled(installed.id) ? () => { setMarketFrom(null); setManage(installed.id) } : undefined}
                backgroundSupported={false}
                phoneAgentCapabilities={detail.manifest.permissions?.capabilities?.filter((capability) => PHONE_CAPABILITY_SUPPORT[capability] === 'agent')}
              />
            </SessionUiTheme>
          </div>
        </Sheet>
      ) : null}
      {manage ? (
        <PhoneAppManage
          extensionId={manage}
          updateVersion={offered.state === 'value' ? offered.value.offered[manage] : undefined}
          gone={offered.state === 'value' && offered.value.gone.includes(manage)}
          onClose={() => setManage(null)}
          onViewInMarket={() => {
            const item = full?.items.find((row) => row.manifest.id === manage)
            if (item) {
              setMarketFrom(manage)
              setDetail(item)
            } else setFailed({ title: translate('extensions.marketUnavailable'), cause: manage })
            setManage(null)
          }}
        />
      ) : null}
    </>
  )
}
