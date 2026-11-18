import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { IconButton } from '@/components/ui/IconButton'
import { MachineList } from '@/components/ui/MachineList'
import { Sheet } from '@/components/ui/Sheet'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source'
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host'
import type { MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { ExtensionsSettingsCard } from '@renderer/features/settings/components/ExtensionsSettingsCard'
import { InstalledAgents } from './InstalledAgents'
import { InstalledConnectors } from './InstalledConnectors'
import { InstalledItems, type InventoryView } from './InstalledItems'
import type { InstalledItem, InstalledSection } from './installed-item'
import './installed-manager.css'

export const InstalledManager = observer(function InstalledManager({
  initialSection = 'agents', initialDeviceId, onClose, onOpenAgent, onOpenApp,
}: {
  initialSection?: InstalledSection
  initialDeviceId?: string
  onClose: () => void
  onOpenAgent: (id: string, deviceId?: string) => void
  onOpenApp: (id: string, deviceId?: string) => void
}) {
  const { t } = useTranslation('main')
  const [section, setSection] = useState(initialSection)
  const [layout, setLayout] = useState<InventoryView>('grid')
  const [selected, setSelected] = useState(initialDeviceId ?? LOCAL_IMPORT_DEVICE)
  const choices = importDeviceChoices(t('installedManager.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device))
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
      section={section} setSection={setSection} layout={layout} setLayout={setLayout}
      remoteLabel={deviceId ? machine.label : undefined} />
  )
  const openApp = (id: string) => { onClose(); onOpenApp(id, deviceId) }
  const openAgent = (id: string) => { onClose(); onOpenAgent(id, deviceId) }

  return (
    <Sheet ariaLabel={t('installedManager.title')} onClose={onClose}
      desktopWidth="960px" desktopHeight="680px" desktopMaxHeight="calc(100dvh - 32px)" testId="installed-manager">
      <div className="gg-installed-frame">
        <header className="gg-installed-header">
          <h2>{t('installedManager.title')}</h2>
          <IconButton aria-label={t('settings.close')} onClick={onClose}><X size={16} /></IconButton>
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
              <InstalledConnectors render={renderItems} directManagement={initialSection === 'connectors'} />
            )}
          </LibraryHostProvider>
        </div>
      </div>
    </Sheet>
  )
})
