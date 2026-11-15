import { useLocale } from '@/i18n'
import type { ConnectionMetadataStore } from '../connections/connection-metadata'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { useAssistantIntegrationDetail } from './assistant-panel-reads'

/**
 * The full catalog entry of a connection the list only summarised (replica `assistantIntegrationDetail`): `data` is the
 * summary when it is already full; null while the entry is not read (the caller draws the summary and a spinner).
 */
export function useAssistantPanelIntegration(panel: ConnectionMetadataStore | undefined,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const { summaryIsFull, reading } = useAssistantIntegrationDetail(panel,summary,resolvedLocale)
  if (summaryIsFull) return { data: summary,error: null,loading: false }
  return { data: reading.state === 'value' ? reading.value : null,error: reading.state === 'error' ? reading.error : null,
    loading: !!panel && reading.state === 'unknown' }
}
