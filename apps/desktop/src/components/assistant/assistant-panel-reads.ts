import { useEffect, useMemo } from 'react'
import type { AssistantPanelDomain, AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import { readableAssistantPanelCollection } from '@gugu/core/cloud/assistantPanelFiles'
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { replica, useReplica, type Reading } from '@/lib/replica'
import { assistantPanelBodies } from '@/lib/assistantPanelBodies'
import { readMemoryEntry, type AssistantMachine, type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { connectionMetadataKey, type ConnectionMetadataStore } from '../connections/connection-metadata'
import { CONNECTIONS_CHANGED, peekOwnerConnectionMetadata, readOwnerConnectionMetadata } from '../connections/owner-connection-metadata'
import { peekAssistantPanelIntegration, peekAssistantPanelIntegrations, readAssistantPanelIntegration, readAssistantPanelIntegrations } from './assistant-panel-integrations'
import { onAssistantPanelChanged, useAssistantPanel } from './assistant-panel-replica'

// Live objects (stores, machines) the key-only replicas below find by key; an unregistered key is a failed read (❌ a hang).
const stores = new Map<string, ConnectionMetadataStore>()
const machines = new Map<string, AssistantMachine>()

export function registerConnectionStore(store: ConnectionMetadataStore): string {
  const key = connectionMetadataKey(store)
  stores.set(key, store)
  return key
}

function storeOf(key: string): ConnectionMetadataStore {
  const store = stores.get(key)
  if (!store) throw new Error(`The store of this connection is not registered (${key})`)
  return store
}

/** 同一个工作区(机器、项目、工作区、记忆夹)= 同一个键;重新打开过的工作区换键重读。 */
function registerAssistantMachine(machine: AssistantMachine): string {
  const key = `${machine.panel?.ownerId ?? ''}|${machine.panel?.assistantId ?? ''}|${machine.deviceId}|${machine.projectId}|${machine.workspaceId}|${machine.paths.memoryDir}`
  machines.set(key, machine)
  return key
}

function machineOf(key: string): AssistantMachine {
  const machine = machines.get(key)
  if (!machine) throw new Error(`The assistant's workspace is not registered (${key})`)
  return machine
}

type ConnectionList = Awaited<ReturnType<typeof readAssistantPanelIntegrations>>

/** The applications a connection store lists. Signal tier: its panel's changes and `CONNECTIONS_CHANGED` (`useConnectionList`). */
export const connectionList = replica({
  name: 'connectionList',
  scope: 'account',
  read: async (_owner: string, storeKey: string, owned: boolean, locale: string): Promise<ConnectionList> => {
    const store = storeOf(storeKey)
    return withAssistantPanelReadDeadline(() => (owned ? readOwnerConnectionMetadata(store, locale) : readAssistantPanelIntegrations(store, locale)))
  },
  local: (_owner: string, storeKey: string, owned: boolean, locale: string) => {
    const store = stores.get(storeKey)
    if (!store) return undefined
    return (owned ? peekOwnerConnectionMetadata(store, locale) : peekAssistantPanelIntegrations(store, locale)) ?? undefined
  },
  retry: 2,
  refreshOnFocus: true,
})

const listWatches = new Map<string, { users: number; stop: () => void }>()
function watchConnectionList(store: ConnectionMetadataStore): () => void {
  const key = connectionMetadataKey(store)
  let entry = listWatches.get(key)
  if (!entry) {
    const refresh = () => { void connectionList.refresh(key) }
    const stopPanel = store.assistantId ? onAssistantPanelChanged(store.assistantId, refresh) : () => undefined
    window.addEventListener(CONNECTIONS_CHANGED, refresh)
    entry = { users: 0, stop: () => { stopPanel(); window.removeEventListener(CONNECTIONS_CHANGED, refresh) } }
    listWatches.set(key, entry)
  }
  const active = entry
  active.users++
  return () => { if (--active.users === 0 && listWatches.get(key) === active) { active.stop(); listWatches.delete(key) } }
}

export function useConnectionList(store: ConnectionMetadataStore | undefined, owned: boolean, locale: string, enabled = true): Reading<ConnectionList> {
  const key = store ? registerConnectionStore(store) : null
  const reading = useReplica(connectionList, key && enabled ? [key, owned, locale] : null)
  useEffect(() => (store && enabled ? watchConnectionList(store) : undefined), [store, enabled])
  return reading
}

/** One application's full catalog entry, content-addressed by `catalogVersion` (read once). */
export const assistantIntegrationDetail = replica({
  name: 'assistantIntegrationDetail',
  scope: 'account',
  read: async (_owner: string, storeKey: string, id: string, catalogVersion: string | null, locale: string): Promise<IntegrationMetadata> => {
    const store = storeOf(storeKey)
    await assistantPanelBodies.ready
    return withAssistantPanelReadDeadline(() => readAssistantPanelIntegration(store, id, locale, catalogVersion ?? undefined))
  },
  local: (_owner: string, storeKey: string, id: string, _catalogVersion: string | null, locale: string) =>
    peekAssistantPanelIntegration(stores.get(storeKey), id, locale),
  fresh: Infinity,
  // Not retried by itself: a store nobody registered is a failure said at once (C7), and the page offers a retry.
})

export function useAssistantIntegrationDetail(store: ConnectionMetadataStore | undefined, summary: IntegrationMetadata | null | undefined, locale: string) {
  const key = store ? registerConnectionStore(store) : null
  const reading = useReplica(assistantIntegrationDetail, key && summary?.metadataOnly ? [key, summary.id, summary.catalogVersion ?? null, locale] : null)
  return { summaryIsFull: !summary?.metadataOnly, reading }
}

/** One memory note's text, for its revision (immutable for that revision: read once). */
const assistantMemoryBody = replica({
  name: 'assistantMemoryBody',
  scope: 'account',
  read: (_owner: string, workspace: string, entry: MemoryEntry): Promise<MemoryEntry> =>
    withAssistantPanelReadDeadline(() => readMemoryEntry(machineOf(workspace), entry)),
  fresh: Infinity,
  keep: 10 * 60_000,
  // A failed body is said on its card at once (the list stays readable); opening the card again reads it again.
})

export function useAssistantMemoryBody(machine: AssistantMachine | undefined, entry: MemoryEntry): Reading<MemoryEntry> {
  const key = machine ? registerAssistantMachine(machine) : null
  return useReplica(assistantMemoryBody, key && entry.contentPending ? [key, entry] : null)
}

/** One collection of the machine's panel, derived from the `assistantPanel` snapshot (❌ a read of its own); `derive` stable. */
export function useAssistantPanelCollection<T>(machine: AssistantMachine | null | undefined, domain: AssistantPanelDomain,
  derive: (rows: AssistantPanelItem[]) => T): Reading<T> {
  const panel = machine?.panel
  const reading = useAssistantPanel(panel?.ownerId ?? null, panel?.assistantId ?? null)
  const deviceId = panel?.deviceId ?? null
  return useMemo((): Reading<T> => {
    if (reading.state !== 'value' || deviceId === null) return reading.state === 'error' ? reading : { state: 'unknown' }
    try { return { ...reading, value: derive(readableAssistantPanelCollection(reading.value, domain, deviceId)) } }
    catch (error) { return { state: 'error', error: error as Error } }
  }, [reading, deviceId, domain, derive])
}
