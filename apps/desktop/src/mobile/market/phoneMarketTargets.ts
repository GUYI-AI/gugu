import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { Device } from '@gugu/core/shared/types/chat'
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store'
import { askInShell, installConsentPrompt } from '@renderer/features/extensions/install-consent'
import { isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order'
import { managedInstallOption, resolveManagedSourceUpdate } from '@renderer/features/settings/agents-page/agent-source-actions'
import type { LibraryHost } from '@renderer/features/library/library-host'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions'
import { installAgreedOn } from '@shared/extensions/install-agreed-on'
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
  const client = useQueryClient()
  const entries = devices.map(device => ({ device, host: marketDeviceHost(device) }))
  const keys = entries.map(({ device }) => ['market-device', plans.key, device.device_id])
  const queries = useQueries({ queries: entries.map((target, index) => ({
    queryKey: keys[index]!,
    queryFn: () => plans.read(target),
    enabled: target.device.is_online,
    staleTime: 30_000,
    retry: false,
  })) })
  return entries.map((target, index) => {
    const { device } = target
    const query = queries[index]!
    const reading = query.data === undefined ? null : plans.describe(query.data, target)
    const unavailable = !device.is_online ? 'offline' : query.isError ? 'unavailable' : query.isPending ? 'checking' : null
    return {
      id: device.device_id,
      name: device.label || device.hostname,
      present: reading?.present ?? false,
      status: unavailable ?? reading?.status,
      install: !unavailable && reading?.install ? async () => {
        const installed = await reading.install!()
        if (installed) {
          await client.invalidateQueries({ queryKey: keys[index] })
          void client.invalidateQueries({ queryKey: ['agents'] })
          void client.invalidateQueries({ queryKey: APP_INVENTORY_KEY })
        }
        return installed
      } : undefined,
    } satisfies PhoneMarketInstallRow & { present: boolean }
  })
}

type AppReading = { installedVersion?: string; preinstalled: boolean; offered: MarketListItem | null }

async function readApplication({ host }: Target, id: string): Promise<AppReading> {
  const { api } = host.extensions
  const [inventory, market] = await Promise.all([api.list(), api.marketEntry({ extensionId: id })])
  if (!inventory.success || !inventory.data) throw new Error(inventory.error)
  if (!market.success) throw new Error(market.error)
  return {
    installedVersion: inventory.data.extensions.find(item => item.id === id)?.version,
    preinstalled: inventory.data.origins?.[id] === 'preinstalled',
    offered: market.data ?? null,
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
          const result = await installAgreedOn(
            consent => host.extensions.api.installFromMarket({ ref: offered.ref, consent }),
            async (reply) => {
              const { ask } = reply
              if (!ask) return { declined: 'missing-manifest' }
              if (!reply.asks) return { digest: ask.manifestDigest }
              const prompt = installConsentPrompt({ ...ask, machine }, ask.manifest)
              const answer = await askInShell(prompt, crypto.randomUUID(), INSTALL_CONSENT_HUMAN_WINDOW_MS, ask.given, undefined, machine)
              return answer?.outcome === 'confirmed' ? { digest: ask.manifestDigest } : { declined: answer?.outcome ?? 'no-dialog' }
            },
          )
          if (!result || 'declined' in result) return false
          await host.extensions.store.load()
          return true
        },
      }
    },
  })
}

export function usePhoneAgentInstallTargets(id: string, devices: readonly Device[]) {
  return usePhoneMarketTargets(devices, {
    key: `agent:${id}`,
    read: ({ host }) => host.agents.getManagement(id),
    describe: (agent: AgentPayload | null, { host }) => {
      if (!agent?.reading) return { status: 'unavailable' }
      const present = isInstalledAgent(agent)
      const registry = agent.used?.registry
      const method = managedInstallOption(agent.installOptions, registry)
      const managedCopy = agent.installations.find(item => item.provenance.ours)
      const update = resolveManagedSourceUpdate({ agent, managedCopy, managedInstall: method, registry,
        companionUpdate: agent.programs?.slice(1).some(item => item.managedUpdateAvailable) ?? false })
      if (present && !update) return { present, status: 'installed' }
      if (!method && !update) return { present, status: 'unavailable' }
      const plan = update ?? { kind: 'install' as const, method: method!.method, registry: method!.registry }
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

const APP_INVENTORY_KEY = ['market-installed-apps'] as const

export function usePhoneMarketInstalledAppIds(devices: readonly Device[]): Set<string> {
  const inventory = useQueries({ queries: devices.map(device => ({
    queryKey: [...APP_INVENTORY_KEY, device.device_id],
    queryFn: async () => {
      const { store } = marketDeviceHost(device).extensions
      await store.load()
      return store.manifests.map(app => app.id)
    },
    staleTime: 30_000,
    enabled: device.is_online,
    retry: false,
  })) })
  return new Set([...installedExtensionsStore.manifests.map(app => app.id), ...inventory.flatMap(entry => entry.data ?? [])])
}
