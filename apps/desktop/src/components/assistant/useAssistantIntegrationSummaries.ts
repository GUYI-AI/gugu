import type { ConnectionMetadataStore } from '../connections/connection-metadata'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { builtinIntegrationSummary } from '@gugu/session-plugins/integration-summaries'
import { useReplicas } from '@/lib/replica'
import { integrationListCopy } from './assistant-panel-integrations'
import { assistantIntegrationDetail,registerConnectionStore } from './assistant-panel-reads'

export const EMPTY_INTEGRATION_SUMMARIES: IntegrationMetadata[] = []

/** A metadata-only row whose list text is missing: its name and description are read from its full entry. */
const lacksSummary = (item: IntegrationMetadata,locale: string) =>
  item.metadataOnly && !builtinIntegrationSummary(item.id,locale) && (!item.description || item.name === item.id || item.summaryNameMissing)

/**
 * The list's missing names and descriptions, from the same entry the detail page reads (replica
 * `assistantIntegrationDetail`: one body read per catalog version, ❌ a second holder of it). Optional enrichment: a row
 * whose entry is not read yet, or cannot be, keeps the text it has.
 */
export function useAssistantIntegrationSummaries(panel: ConnectionMetadataStore | undefined,items: IntegrationMetadata[],locale: string): IntegrationMetadata[] {
  const storeKey = panel ? registerConnectionStore(panel) : null
  const missing = storeKey ? items.filter(item => lacksSummary(item,locale)) : []
  const readings = useReplicas(assistantIntegrationDetail,missing.map(item => [storeKey!,item.id,item.catalogVersion ?? null,locale] as [string,string,string | null,string]))
  const read = new Map(missing.map((item,index) => {
    const reading = readings[index]!
    return [item.id,reading.state === 'value' ? reading.value : null] as const
  }))
  return items.map(item => {
    const detail = read.get(item.id) ?? null
    const name = detail && (item.summaryNameMissing || item.name === item.id) ? detail.name : item.name
    return { ...item,...integrationListCopy(item.id,name,item.description || detail?.description,locale) }
  })
}
