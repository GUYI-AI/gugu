import { useEffect, useMemo } from 'react'
import { observer } from 'mobx-react-lite'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { chatChannels } from '@/components/connections/connection-replicas'
import { refreshFailure, useReplica } from '@/lib/replica'
import { withoutAssistantHome } from '@/lib/assistantHome'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { appAssistantCountsOf } from '@/session/shared/extensions/assistant-binding'
import { useDevicesStore } from '@/store/devicesContext'
import type { PhoneMachineState } from './phoneMachine'
import { phoneProjectRows } from './phoneProjectRows'
import { usePhoneIntegrations } from './usePhoneProfileData'
import { useMachineLabel } from '../agent-watch/useMachineLabel'

const LOADING = { state: 'loading' } as const
const UNREADABLE = { state: 'unreadable' } as const
const ready = <T,>(value: T) => ({ state: 'ready' as const, value })

/**
 * #1931 The numbers the phone's own 资料 rows showed (devices, connected apps, projects), read from the same
 * sources under the same keys, for the assistant App's 资料 on this phone (`gugu.assistant.status` `counts`, as a computer
 * hands them, assistant-app-counts.tsx). Each a read state; never 0 for "not read". Drawn nowhere; only while the App is
 * the layer's page.
 */
export const PhoneAssistantCountsSource = observer(function PhoneAssistantCountsSource({ ownerId, machine, cloudDeviceId }: {
  ownerId: string
  machine: PhoneMachineState
  cloudDeviceId: string | null
}) {
  const devices = useDevicesStore()
  const integrations = usePhoneIntegrations(machine, true)
  const chats = useReplica(chatChannels, [])
  // 项目数与「助理 → 工作区」同一份:accountProjectsStore + phoneProjectRows(❌ 这里自己再读、再轮询)。
  const { isHome } = useMachineLabel()
  const { status, projects: accountList } = accountProjectsStore
  const projectCount = useMemo(() => (status === 'ready' ? phoneProjectRows(accountList, devices.devices, isHome).length : null), [status, accountList, devices.devices, isHome])
  const counts = appAssistantCountsOf({
    devices: devices.error ? UNREADABLE : devices.loading ? LOADING
      : ready(deviceMachines(withoutAssistantHome([...devices.devices, ...(devices.phones ?? [])], cloudDeviceId)).length),
    // A refresh that failed over what was read is unreadable too, as on the computer (assistant-app-counts.tsx): the contract
    // has no "last read" state (❌ the old count handed over as current).
    connectedApps: integrations.error || refreshFailure(chats) ? UNREADABLE
      : integrations.data && chats.state === 'value'
        ? ready(assistantApplicationCounts(integrations.data.items, integrations.data.configured, integrations.data.statuses, chats.value)) : LOADING,
    projects: projectCount !== null ? ready(projectCount) : status === 'error' ? UNREADABLE : LOADING,
  })
  const key = JSON.stringify(counts)
  useEffect(() => {
    phoneAssistantLayer.publishCounts({ ownerId, counts: JSON.parse(key) })
  }, [ownerId, key])
  useEffect(() => () => phoneAssistantLayer.publishCounts(null), [])
  return null
})
