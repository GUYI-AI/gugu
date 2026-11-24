import { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { MachineList } from '@/components/ui/MachineList'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source'
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host'
import { orderMachines, type MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { ExtensionsSettingsCard } from '@renderer/features/settings/components/ExtensionsSettingsCard'
import { InstalledAgents } from './InstalledAgents'
import { InstalledConnectors } from './InstalledConnectors'
import { InstalledItems, pageScroller, type InventoryView } from './InstalledItems'
import type { InstalledItem, InstalledSection } from './installed-item'
import type { AppsLocation } from '@renderer/features/apps/apps-location'
import './installed-manager.css'

type InstalledPlace = NonNullable<AppsLocation['installed']>

/** The Installed page, at `place` (the Apps location's `installed`), listing `section` (the tab): every change of device or layout moves it. */
export const InstalledManager = observer(function InstalledManager({
  place, section, onPlace, onOpenAgent, onOpenApp,
}: {
  place: InstalledPlace
  section: InstalledSection
  onPlace: (next: InstalledPlace) => void
  onOpenAgent: (id: string, deviceId?: string) => void
  onOpenApp: (id: string, deviceId?: string) => void
}) {
  const { t } = useTranslation('main')
  const itemsRef = useRef<HTMLDivElement>(null)
  const { layout = 'grid' } = place
  const selected = place.deviceId ?? LOCAL_IMPORT_DEVICE
  const setLayout = (next: InventoryView) => onPlace({ ...place, layout: next })
  const setSelected = (id: string) => onPlace({ ...place, deviceId: id === LOCAL_IMPORT_DEVICE ? undefined : id, scroll: undefined })
  const choices = orderMachines(importDeviceChoices(t('installedManager.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device).filter((device) => !device.isCurrentMachine)))
  useEffect(() => { remoteHostsStore.start() }, [])

  const selectedChoice = choices.find(({ id }) => id === selected)
  const machine: MachineChoice = selectedChoice ?? (selected === LOCAL_IMPORT_DEVICE ? choices[0]! : {
    id: selected, label: selected, isLocal: false, isOnline: false,
  })
  const deviceId = machine.isLocal ? undefined : machine.id
  const device = deviceId ? remoteHostsStore.device(deviceId) : null
  const host = machineLibraryHost(deviceId ? {
    deviceId,
    deviceLabel: machine.label,
    online: machine.isOnline && !machine.cloudComputer,
    lastSeenAt: device?.lastSeenAt ?? null,
    hostKind: device?.hostKind,
  } : null)
  const visibleChoices = selectedChoice ? choices : [...choices, machine]
  const renderItems = (items: readonly InstalledItem[], state?: { loading?: boolean; error?: boolean }) => (
    <InstalledItems key={`${machine.id}:${section}`} items={items} {...state} offline={host.remote?.online === false}
      section={section} layout={layout} setLayout={setLayout}
      remoteLabel={deviceId ? machine.label : undefined} itemsRef={itemsRef} scroll={place.scroll} />
  )
  // Opening one is a step away from this page: it keeps how far down the list was, for coming back.
  const leave = () => onPlace({ ...place, scroll: pageScroller(itemsRef.current)?.scrollTop ?? 0 })
  const openApp = (id: string) => { leave(); onOpenApp(id, deviceId) }
  const openAgent = (id: string) => { leave(); onOpenAgent(id, deviceId) }

  return (
    <div className="gg-installed-body" data-testid="installed-manager">
      <MachineList label={t('settings.nav.devices')} machines={visibleChoices} selected={machine.id}
        onlineLabel={t('installedManager.online')} offlineLabel={t('installedManager.offlineStatus')} onSelect={setSelected} />
      <LibraryHostProvider value={host} key={host.key}>
        {host.remote?.online === false ? renderItems([]) : section === 'agents' ? (
          <InstalledAgents render={renderItems} onOpenAgent={openAgent} />
        ) : section === 'apps' ? (
          <ExtensionsSettingsCard renderInstalledApps={renderItems} onOpenInstalledApp={openApp} />
        ) : (
          <InstalledConnectors render={renderItems} directManagement={place.direct === true} />
        )}
      </LibraryHostProvider>
    </div>
  )
})
