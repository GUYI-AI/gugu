import type { Device } from '@gugu/core/shared/types/chat'
import { useReplicas, type Reading as ReplicaReading } from '@/lib/replica'
import { marketDeviceReading, readOnDevicesWith } from '@renderer/features/extensions/market-device-readings'
import { PHONE_HOST } from '@renderer/features/extensions/extensions-api'
import { installedExtensions, useInstalledApps, type InstalledExtensionsList } from '@renderer/features/extensions/installed-extensions'
import { marketEntry } from '@renderer/features/extensions/market-replicas'
import { managementAgent, refreshAgentReadings } from '@renderer/lib/stores/agent-replicas'
import { askInShell, installConsentPrompt } from '@renderer/features/extensions/install-consent'
import { isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order'
import { marketAgentInstallPlan } from '@renderer/features/extensions/panel/market-agent-install-plan'
import { commitMarketInstall, prepareMarketInstall } from '@renderer/features/extensions/panel/market-extension-install-rpc'
import type { LibraryHost } from '@renderer/features/library/library-host'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions'
import { compareExtensionVersions } from '@shared/extensions/manifest'
import type { MarketListItem } from '@shared/extensions/market'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import type { PhoneMarketInstallRow } from './PhoneMarketInstallSheet'
import { marketDeviceHost } from './marketDeviceHost'

type Target = { device: Device; host: LibraryHost }
type Reading = Pick<PhoneMarketInstallRow, 'status' | 'install'> & { present?: boolean }
type Plans<T> = {
  key: string
  read(target: Target): Promise<T>
  describe(value: T, target: Target): Reading
}

function usePhoneMarketTargets<T>(devices: readonly Device[], plans: Plans<T>) {
  const readKey = `phone:${plans.key}`
  readOnDevicesWith(readKey, (deviceId) => {
    const device = devices.find((one) => one.device_id === deviceId)
    if (!device) throw new Error(`No device ${deviceId}`)
    return plans.read({ device, host: marketDeviceHost(device) })
  })
  const entries = devices.map(device => ({ device, host: marketDeviceHost(device) }))
  // An offline device is not asked (nothing would answer): it says so instead.
  const readings = useReplicas(marketDeviceReading, entries.flatMap(({ device }) => device.is_online ? [[readKey, device.device_id] as [string, string]] : []))
  let next = 0
  return entries.map((target) => {
    const { device } = target
    const query = device.is_online ? readings[next++]! as ReplicaReading<T> : null
    const reading = query?.state === 'value' ? plans.describe(query.value, target) : null
    const unavailable = !query ? 'offline' : query.state === 'error' ? 'unavailable' : query.state === 'unknown' ? 'checking' : null
    const present = reading?.present ?? false
    return {
      id: device.device_id,
      name: device.label || device.hostname,
      present,
      status: unavailable ?? reading?.status,
      install: !unavailable && reading?.install ? async () => {
        const installed = await reading.install!()
        if (installed) {
          // What the reading is made of first (the device's installed list, its agents), then the reading.
          await Promise.all([installedExtensions.refresh(target.host.extensions.key), refreshAgentReadings(device.device_id)])
          await marketDeviceReading.refresh(readKey, device.device_id)
        }
        return installed
      } : undefined,
    } satisfies PhoneMarketInstallRow & { present: boolean }
  })
}

type AppReading = { installedVersion?: string; preinstalled: boolean; offered: MarketListItem | null }

/** What a device has and is offered, through that host's installed list and market entry. */
async function readApplication({ host }: Target, id: string): Promise<AppReading> {
  const [inventory, offered] = await Promise.all([installedExtensions.fetch(host.extensions.key), marketEntry.fetch(host.extensions.key, id)])
  return {
    installedVersion: inventory.extensions.find(item => item.id === id)?.version,
    preinstalled: inventory.origins?.[id] === 'preinstalled',
    offered,
  }
}

export function usePhoneAppInstallTargets(id: string, devices: readonly Device[]) {
  return usePhoneMarketTargets(devices, {
    key: `application:${id}`,
    read: target => readApplication(target, id),
    describe: ({ installedVersion, preinstalled, offered }, { device, host }) => {
      const present = installedVersion !== undefined
      if (preinstalled || present && (!offered || compareExtensionVersions(offered.cloud.version, installedVersion) <= 0)) {
        return { present, status: 'installed' }
      }
      if (!offered || offered.cloud.compat) return { present, status: 'unavailable' }
      return {
        present,
        status: present ? 'update' : undefined,
        install: async () => {
          const machine = device.label || device.hostname
          const { ask, asks } = await prepareMarketInstall(host.extensions.api, offered.ref)
          if (asks) {
            const prompt = installConsentPrompt({ ...ask, machine }, ask.manifest)
            const answer = await askInShell(prompt, crypto.randomUUID(), INSTALL_CONSENT_HUMAN_WINDOW_MS, ask.given, undefined, machine)
            if (answer?.outcome !== 'confirmed') return false
          }
          const result = await commitMarketInstall(host.extensions.api, ask)
          if (!result.success) throw new Error(result.error)
          return true
        },
      }
    },
  })
}

export function usePhoneAgentInstallTargets(id: string, devices: readonly Device[]) {
  return usePhoneMarketTargets(devices, {
    key: `agent:${id}`,
    read: ({ device }) => managementAgent.fetch(device.device_id, id),
    describe: (agent: AgentPayload | null, { host }) => {
      if (!agent?.reading) return { status: 'unavailable' }
      const present = isInstalledAgent(agent)
      const plan = marketAgentInstallPlan(agent)
      if (!plan) return { present, status: present ? 'installed' : 'unavailable' }
      return {
        present,
        status: present ? 'update' : undefined,
        install: async () => {
          const result = await host.agents[plan.kind](agent.id, plan.method, plan.registry) as { success?: boolean } | null
          return result?.success === true
        },
      }
    },
  })
}

/** What is installed on each online device (its `installedExtensions` entry); an offline one is not asked. */
export function useDeviceInstalledReadings(devices: readonly Device[]): ReplicaReading<InstalledExtensionsList>[] {
  return useReplicas(installedExtensions, devices.filter(device => device.is_online).map(device => [marketDeviceHost(device).extensions.key] as [string]))
}

export function usePhoneMarketInstalledAppIds(devices: readonly Device[]): Set<string> {
  const here = useInstalledApps(PHONE_HOST)
  const there = useDeviceInstalledReadings(devices)
  // The Apps known to be installed: a device not read yet adds none (its rows say they are being checked).
  const ids = new Set<string>()
  if (here.state === 'value') for (const app of here.value.manifests) ids.add(app.id)
  for (const entry of there) if (entry.state === 'value') for (const app of entry.value.extensions) ids.add(app.id)
  return ids
}
