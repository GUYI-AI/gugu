import { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections'
import { AssistantLibraryCount, type LibraryCountRead } from '@/components/assistant/AssistantLibraryVolume'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { useChatChannels } from '@/components/settings/channels/useChatChannels'
import { withoutAssistantHome } from '@/lib/assistantHome'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { appAssistantCountsOf, type AppAssistantReadState } from '@/session/shared/extensions/assistant-binding'
import { useDevicesStore } from '@/store/devicesContext'
import type { PhoneMachineState } from './phoneMachine'
import { phoneProjectRows } from './phoneProjectRows'
import { usePhoneIntegrations } from './usePhoneProfileData'
import { useMachineLabel } from '../agent-watch/useMachineLabel'

const LOADING = { state: 'loading' } as const
const UNREADABLE = { state: 'unreadable' } as const
const ready = <T,>(value: T) => ({ state: 'ready' as const, value })
const fromLibrary = (read: LibraryCountRead): AppAssistantReadState<number> => (typeof read === 'number' ? ready(read) : read === 'failed' ? UNREADABLE : LOADING)

/**
 * #1931 The numbers the phone's own 资料 rows showed (devices, connected apps, projects, capabilities), read from the same
 * sources under the same keys, for the assistant App's 资料 on this phone (`gugu.assistant.status` `counts`, as a computer
 * hands them, assistant-app-counts.tsx). Each a read state; never 0 for "not read". Drawn nowhere; only while the App is
 * the layer's page.
 */
export const PhoneAssistantCountsSource = observer(function PhoneAssistantCountsSource({ ownerId, assistantId, machine, cloudDeviceId }: {
  ownerId: string
  assistantId: string
  machine: PhoneMachineState
  cloudDeviceId: string | null
}) {
  const devices = useDevicesStore()
  const integrations = usePhoneIntegrations(machine, true)
  const chats = useChatChannels()
  // 项目数与「助理 → 工作区」同一份:accountProjectsStore + phoneProjectRows(❌ 这里自己再读、再轮询)。
  const { isHome } = useMachineLabel()
  const { status, projects: accountList } = accountProjectsStore
  const projectCount = useMemo(() => (status === 'ready' ? phoneProjectRows(accountList, devices.devices, isHome).length : null), [status, accountList, devices.devices, isHome])
  const [capabilities, setCapabilities] = useState<LibraryCountRead>('loading')
  const counts = appAssistantCountsOf({
    devices: devices.error ? UNREADABLE : devices.loading ? LOADING
      : ready(deviceMachines(withoutAssistantHome([...devices.devices, ...(devices.phones ?? [])], cloudDeviceId)).length),
    connectedApps: integrations.error || chats.status === 'failed' ? UNREADABLE
      : integrations.data && (chats.status === 'ready' || chats.status === 'absent')
        ? ready(assistantApplicationCounts(integrations.data.items, integrations.data.configured, integrations.data.statuses, chats.list)) : LOADING,
    projects: projectCount !== null ? ready(projectCount) : status === 'error' ? UNREADABLE : LOADING,
    capabilities: machine.state === 'error' ? UNREADABLE : fromLibrary(capabilities),
  })
  const key = JSON.stringify(counts)
  useEffect(() => {
    phoneAssistantLayer.publishCounts({ ownerId, counts: JSON.parse(key) })
  }, [ownerId, key])
  useEffect(() => () => phoneAssistantLayer.publishCounts(null), [])
  const opened = machine.state === 'ready' ? machine.machine : null
  return <AssistantLibraryCount key={assistantId} machine={opened} kind="capabilities" assistantId={assistantId} onCount={setCapabilities} />
})
