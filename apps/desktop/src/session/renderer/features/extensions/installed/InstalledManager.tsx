import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { IconButton } from '@/components/ui/IconButton'
import { MachineList } from '@/components/ui/MachineList'
import { Sheet } from '@/components/ui/Sheet'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source'
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host'
import { orderMachines, type MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { ExtensionsSettingsCard } from '@renderer/features/settings/components/ExtensionsSettingsCard'
import { InstalledAgents } from './InstalledAgents'
import { InstalledConnectors } from './InstalledConnectors'
import { InstalledItems, type InventoryView } from './InstalledItems'
import type { InstalledItem } from './installed-item'
import type { AppsLocation } from '@renderer/features/apps/apps-location'
import './installed-manager.css'

type InstalledPlace = NonNullable<AppsLocation['installed']>

/** The Installed sheet, at `place` (the Apps location's `installed`): every change of segment, device or layout moves it. */
export const InstalledManager = observer(function InstalledManager({
  place, onPlace, onClose, onOpenAgent, onOpenApp,
}: {
  place: InstalledPlace
  onPlace: (next: InstalledPlace) => void
  onClose: () => void
  onOpenAgent: (id: string, deviceId?: string) => void
  onOpenApp: (id: string, deviceId?: string) => void
}) {
  const { t } = useTranslation('main')
  const [modalLayer, setModalLayer] = useState<HTMLDivElement | null>(null)
  const itemsRef = useRef<HTMLDivElement>(null)
  const { section, layout = 'grid' } = place
  const selected = place.deviceId ?? LOCAL_IMPORT_DEVICE
  const setSection = (next: typeof section) => onPlace({ ...place, section: next, scroll: undefined })
  const setLayout = (next: InventoryView) => onPlace({ ...place, layout: next })
  const setSelected = (id: string) => onPlace({ ...place, deviceId: id === LOCAL_IMPORT_DEVICE ? undefined : id, scroll: undefined })
  const choices = orderMachines(importDeviceChoices(t('installedManager.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device).filter((device) => !device.isCurrentMachine)))
  useEffect(() => { remoteHostsStore.start() }, [])
  useLayoutEffect(() => {
    if (!modalLayer) return
    const previous = modalStore.portalContainer
    modalStore.setPortalContainer(modalLayer)
    return () => {
      if (modalStore.portalContainer !== modalLayer) return
      modalStore.activeModalArgs?.onClose()
      modalStore.setPortalContainer(previous?.isConnected ? previous : null)
    }
  }, [modalLayer])

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
      section={section} setSection={setSection} layout={layout} setLayout={setLayout}
      remoteLabel={deviceId ? machine.label : undefined} itemsRef={itemsRef} scroll={place.scroll} />
  )
  // Opening one is a step away from this sheet: it keeps how far down the list was, for coming back.
  const leave = () => onPlace({ ...place, scroll: itemsRef.current?.scrollTop ?? 0 })
  const openApp = (id: string) => { leave(); onOpenApp(id, deviceId) }
  const openAgent = (id: string) => { leave(); onOpenAgent(id, deviceId) }

  return (
    <Sheet ariaLabel={t('installedManager.title')} onClose={onClose}
      desktopWidth="960px" desktopHeight="680px" desktopMaxHeight="calc(100dvh - 32px)" testId="installed-manager">
      <div ref={setModalLayer} className="gg-installed-modal-layer" />
      <UiPortalContainerProvider value={modalLayer}>
        <div className="gg-installed-frame">
          <header className="gg-installed-header">
            <h2>{t('installedManager.title')}</h2>
            <IconButton aria-label={t('dialog.close', { ns: 'common' })} onClick={onClose}><X size={16} /></IconButton>
          </header>
          <div className="gg-installed-body">
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
        </div>
      </UiPortalContainerProvider>
    </Sheet>
  )
})
