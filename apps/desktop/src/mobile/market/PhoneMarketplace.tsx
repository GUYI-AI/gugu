import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink'
import { MobileAppsSection } from '@/components/settings/MobileAppsSection'
import { SettingsDetailNavigation, type SettingsDetailState } from '@/components/settings/SettingsDetailNavigation'
import { IconButton } from '@/components/ui/IconButton'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Sheet } from '@/components/ui/Sheet'
import { withoutAssistantHome } from '@/lib/assistantHome'
import { ChevronLeft } from '@/lib/icons'
import { queryClient } from '@/lib/replica'
import { cloudSnapshotOf, useCloudComputer } from '@/lib/cloudComputer'
import { useDevicesStore } from '@/store/devicesContext'
import type { PhoneAssistantState } from '../assistant/usePhoneAssistant'
import { PhoneMarketAgents, PhoneMarketLocalAgents } from './PhoneMarketAgents'
import { PhoneMarketConnections } from './PhoneMarketConnections'
import { PhoneMarketRemoteApps } from './PhoneMarketRemoteApps'
import './phone-market.css'

const AREAS = ['agents', 'apps', 'connectors'] as const
type Area = typeof AREAS[number]

interface Props {
  initialArea: Area
  assistant?: PhoneAssistantState
  appDetail?: ExtensionAppDetailLink
  onHandledAppDetail?: () => void
  showMarketTabs: boolean
  installedOpen: boolean
  onCloseInstalled(): void
}

export function PhoneMarketplace({ initialArea, assistant, appDetail, onHandledAppDetail, showMarketTabs, installedOpen, onCloseInstalled }: Props) {
  const [area, setArea] = useState(initialArea)
  const [requestedApp, setRequestedApp] = useState(() => appDetail ? { link: appDetail, installed: true } : undefined)
  useEffect(() => { if (appDetail) setRequestedApp({ link: appDetail, installed: true }) }, [appDetail])
  const { devices, phones } = useDevicesStore()
  const homeId = cloudSnapshotOf(useCloudComputer())?.deviceId ?? null
  const { desktopDevices, thisPhone } = useMemo(() => {
    const endpoints = [...devices, ...(phones ?? [])]
    const desktopDevices = deviceMachines(withoutAssistantHome(endpoints.filter(device => !isPhoneDevice(device)), homeId))
      .map(machine => machine.device)
    return { desktopDevices, thisPhone: endpoints.find(device => device.is_current_device && isPhoneDevice(device)) ?? null }
  }, [devices, phones, homeId])
  const catalogHost = desktopDevices.find(device => device.is_online) ?? desktopDevices[0] ?? null
  return <QueryClientProvider client={queryClient}>
    <div className="phone-market" data-testid="phone-market">
      <MarketAreas area={area} onAreaChange={setArea} showTabs={showMarketTabs}>
        {area === 'agents' && <PhoneMarketAgents device={catalogHost} targets={desktopDevices} installed={false} onOpenApp={link => setRequestedApp({ link, installed: false })} />}
        {(area === 'apps' || requestedApp) && <MobileAppsSection mode={area === 'apps' ? 'market' : 'detail'} devices={desktopDevices}
          appDetail={requestedApp?.link} openInstalledDetail={requestedApp?.installed}
          onHandledAppDetail={onHandledAppDetail} onCloseRequestedDetail={requestedApp ? () => setRequestedApp(undefined) : undefined} />}
        {area === 'connectors' && <PhoneMarketConnections assistant={assistant} mode="market" devices={desktopDevices} installedDeviceId={null} />}
      </MarketAreas>
    </div>
    {installedOpen && <InstalledMarket initialArea={area} devices={desktopDevices} thisPhone={thisPhone}
      assistant={assistant} onClose={onCloseInstalled} />}
  </QueryClientProvider>
}

function MarketAreas({ area, onAreaChange, showTabs = true, children }: {
  area: Area
  onAreaChange(area: Area): void
  showTabs?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('main')
  const id = useId()
  const items = AREAS.map(value => ({ value, label: t(`phoneMarket.${value}`), panelId: `${id}-${value}` }))
  return <>
    {showTabs && <div className="phone-market-tabs">
      <SegmentedTabs items={items} value={area} onChange={onAreaChange} ariaLabel={t('settings.nav.apps')} />
    </div>}
    <div id={`${id}-${area}`} role="tabpanel" aria-label={t(`phoneMarket.${area}`)}>{children}</div>
  </>
}

function InstalledMarket({ initialArea, devices, thisPhone, assistant, onClose }: {
  initialArea: Area
  devices: readonly Device[]
  thisPhone: Device | null
  assistant?: PhoneAssistantState
  onClose(): void
}) {
  const { t } = useTranslation('main')
  const [area, setArea] = useState(initialArea)
  const [deviceId, setDeviceId] = useState('')
  const [detail, setDetail] = useState<SettingsDetailState>(null)
  const selected = devices.find(device => device.device_id === deviceId)
  const scope = selected?.device_id ?? (area === 'connectors' && deviceId !== 'this-phone' ? 'account' : 'this-phone')
  const selectedId = scope === 'account' ? null : selected?.device_id ?? thisPhone?.device_id ?? null
  const back = detail ? detail.back : onClose
  return <Sheet fullScreenMobile onClose={back} ariaLabel={t('phoneMarket.installed')} testId="phone-market-installed">
    <Pane paneRole="detail" mobile className="gg-settings-detail">
      <PaneHeader mobile titleLevel="panel" title={detail?.title ?? t('phoneMarket.installed')}
        leading={<IconButton shape="pill" className="bg-foreground/[0.06]" size="lg" aria-label={t('settings.back')} onClick={back}>
          <ChevronLeft />
        </IconButton>} />
      <div className="gg-settings-body phone-market">
        {!detail && (devices.length > 0 || area === 'connectors' && thisPhone) && <label className="phone-market-device">
          {t('phoneMarket.device')}
          <select value={scope} onChange={event => setDeviceId(event.currentTarget.value)}>
            {area === 'connectors' && <option value="account">{t('phoneMarket.accountConnections')}</option>}
            <option value="this-phone">{t('phoneMarket.thisPhone')}</option>
            {devices.map(device => <option key={device.device_id} value={device.device_id}>{device.label || device.hostname}</option>)}
          </select>
        </label>}
        <SettingsDetailNavigation.Provider value={setDetail}>
          <MarketAreas area={area} onAreaChange={setArea} showTabs={!detail}>
            {area === 'agents' && (selected ? <>
              <PhoneMarketRemoteApps key={`assistant:${selected.device_id}`} device={selected} devices={devices} assistant />
              <PhoneMarketAgents key={selected.device_id} device={selected} targets={devices} installed />
            </> : <PhoneMarketLocalAgents device={thisPhone} />)}
            {area === 'apps' && (selected
              ? <PhoneMarketRemoteApps key={selected.device_id} device={selected} devices={devices} />
              : <MobileAppsSection mode="installed" devices={devices} />)}
            {area === 'connectors' && <PhoneMarketConnections key={selectedId} mode="installed" devices={devices}
              installedDeviceId={selectedId} assistant={assistant} />}
          </MarketAreas>
        </SettingsDetailNavigation.Provider>
      </div>
    </Pane>
  </Sheet>
}
