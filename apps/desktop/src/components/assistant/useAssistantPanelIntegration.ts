import { useLocale } from '@/i18n'
import type { ConnectionMetadataStore } from '../connections/connection-metadata'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { useAssistantIntegrationDetail } from './assistant-panel-reads'

/** The full catalog entry of a summarised connection; `data` is the summary when already full, null while not read. */
export function useAssistantPanelIntegration(panel: ConnectionMetadataStore | undefined,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const { summaryIsFull, reading } = useAssistantIntegrationDetail(panel,summary,resolvedLocale)
  if (summaryIsFull) return { data: summary,error: null,loading: false }
  return { data: reading.state === 'value' ? reading.value : null,error: reading.state === 'error' ? reading.error : null,
    loading: !!panel && reading.state === 'unknown' }
}
