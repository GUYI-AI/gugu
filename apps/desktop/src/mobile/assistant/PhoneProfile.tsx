import { useTranslation } from 'react-i18next'
import { useDevicesStore } from '../../store/devicesContext'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceMachineFor, deviceMachines } from '@gugu/core/shared/deviceMachines'
import { AssistantSettingsPage } from '@/components/assistant/AssistantSettingsPage'
import type { ComponentType } from 'react'
import { AgentAiModelPane } from '@/components/agentsettings/AgentAiModelPane'
import { AgentLookPane } from '@/components/agentsettings/AgentLookPane'
import type { AgentSettingsPaneProps } from '@/components/agentsettings/types'
import { useAssistantHome } from '@/lib/useAssistantHome'
import { AssistantDevicesPage } from '@/components/devices/AssistantDevicesPage'
import { DeviceRenameField } from '@/components/devices/DeviceRenameField'
import { IconButton } from '@/components/ui/IconButton'
import { useDeviceRename } from '@/hooks/useDeviceRename'
import { Pencil } from '@/lib/icons'
import { PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { ConnectorsSection } from '@/components/settings/ConnectorsSection'
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary'
import { PhoneConnectorDetail,PhoneConnectorsPage } from './PhoneConnectors'
import { PhoneConnectorSetupPage } from './PhoneConnectorSetup'
import { parseConnectorSub } from './phoneConnectorFlow'
import { PhoneLibraryVolume } from './PhoneLibraryVolume'
import { usePhoneIntegrations } from './usePhoneProfileData'
import './phone-profile.css'

/**
 * The phone's own screens under 资料 (the assistant App draws 资料 itself): its settings and their sections, the model and
 * 换形象 pages, devices, connected apps, and the 项目 / 能力 volumes — each opened as `gugu.assistant.open` opens it.
 */
export function PhoneProfile(input: PhonePageProps) {
  const props: PhonePageProps = input.sub?.startsWith('settings:') ? { ...input,
    sub: input.sub.slice('settings:'.length),
    go: next => input.go(next ? `settings:${next}` : 'settings'),
  } : input
  const { t } = useTranslation('assistant')
  const settings = useTranslation('settings').t
  const devices = useDevicesStore()
  const { sub, go, machine, cloudDeviceId } = props
  const connectors = sub === 'channels' || sub === 'connectors' || !!sub?.startsWith('connector:')
  const integrations = usePhoneIntegrations(machine, connectors)
  const deviceRename = useDeviceRename()
  if (sub === 'library:workspace') return <PhoneLibraryVolume key={sub} {...props} kind="workspace" />
  if (sub === 'library:capabilities' || sub === 'library:devices') return <PhoneLibraryVolume key={sub} {...props} kind={sub === 'library:capabilities' ? 'capabilities' : 'devices'} />

  if (sub === 'settings') return <div className="ta-page ta-phone-profile"><PageHead title={t('nav.settings')} /><div className="ta-skin">
    <AssistantSettingsPage panelNavigation onOpenPage={(tab) => props.open({ tab })} onOpenSection={(section) => go(`settings:${section}`)} />
  </div></div>

  // API 49 `gugu.assistant.open(…, "model" | "look")`: the model page its settings open (AssistantSettingsPage `aimodel`) and the
  // look workshop 自定义's 换形象 opens (AgentLookPane), each as a page of its own — never 自定义 again over the App's own.
  if (sub === 'aimodel') return <PhoneAssistantPane title={t('settingsPage.model')} testId="assistant-model-page" Pane={AgentAiModelPane} />
  if (sub === 'look') return <PhoneAssistantPane title={t('customize.look')} testId="assistant-look-page" Pane={AgentLookPane} />

  if (sub === 'connectors' || sub === 'channels') return <ConnectionRouteBoundary owner={() => <ConnectorsSection panelNavigation />}
    legacy={<PhoneConnectorsPage {...props} integrations={integrations} />} />
  if (sub?.startsWith('connector:')) {
    // `connector:<id>` 详情,`connector:<id>:connect` 连接页(返回箭头回详情,见 assistant-context.parentRoute)。
    const route = parseConnectorSub(sub),id = route?.id ?? sub.slice('connector:'.length)
    return <ConnectionRouteBoundary owner={() => <ConnectorsSection panelNavigation initialConnectorId={id} />}
      legacy={route?.view === 'connect' ? <PhoneConnectorSetupPage {...props} integrations={integrations} id={id} />
        : <PhoneConnectorDetail {...props} integrations={integrations} id={id} />} />
  }
  if (sub === 'devices' || sub?.startsWith('devices:')) {
    const openedDeviceId = sub.startsWith('devices:') ? sub.slice('devices:'.length) : null
    const machine = deviceMachineFor(deviceMachines([...devices.devices, ...(devices.phones ?? [])]), openedDeviceId)
    const opened = machine?.device
    const title = openedDeviceId === 'this-phone' || (machine?.current && opened && isPhoneDevice(opened))
      ? settings('devices.assistantPage.phoneTitle') : opened?.label ?? t('library.devices')
    // 设备页的名字在手机这一页的页头改(页头归手机壳,里面的设备页 embedded 不画页头):同一个改名框、同一条落库路径。
    const renaming = !!opened && deviceRename.editingId === opened.device_id
    const renameFailed = renaming ? deviceRename.failedFor(opened.device_id) : ''
    return (
      <div className="ta-page ta-phone-profile" data-testid="assistant-slot-devices">
        {renaming && opened
          ? <div className="ta-page-head"><div className="min-w-0 flex-1">
            <DeviceRenameField label={opened.label} onSave={(next) => void deviceRename.save(opened, next)} onCancel={deviceRename.cancel} />
            {renameFailed && <p className="ta-page-sub text-[var(--danger-fg)]">{renameFailed}</p>}
          </div></div>
          : <PageHead title={title} action={opened && (
            <IconButton aria-label={settings('devices.menu.rename')} title={settings('devices.menu.rename')} data-testid="settings-device-actions-rename" onClick={() => deviceRename.start(opened)}>
              <Pencil />
            </IconButton>
          )} />}
        <div className="ta-skin">
          <AssistantDevicesPage panelNavigation cloudDeviceId={cloudDeviceId} openedDeviceId={openedDeviceId} onOpenDevice={(id) => go(id ? `devices:${id}` : 'devices')} />
        </div>
      </div>
    )
  }
  return null
}

/** The assistant's model page, the one its settings open (`AssistantSettingsPage` → `AgentAiModelPane`). */
function PhoneAssistantPane({ title, testId, Pane }: { title: string; testId: string; Pane: ComponentType<AgentSettingsPaneProps> }) {
  const { contact } = useAssistantHome()
  return <div className="ta-page ta-phone-profile" data-testid={testId}><PageHead title={title} /><div className="ta-skin">
    {contact ? <Pane agent={contact} /> : null}
  </div></div>
}
