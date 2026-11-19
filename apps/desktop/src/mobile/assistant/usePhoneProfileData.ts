import { EMPTY_INTEGRATION_SUMMARIES,useAssistantIntegrationSummaries } from '@/components/assistant/useAssistantIntegrationSummaries'
import { useLocale } from '@/i18n'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import { cachedAssistantPanelIntegration,peekAssistantPanelIntegration,peekAssistantPanelIntegrations,readAssistantPanelIntegrations,readAssistantPanelIntegration } from '@/components/assistant/assistant-panel-integrations'
import { machineKey, usePhoneRead } from './usePhoneRead'
import type { PhoneMachineState } from './phoneMachine'
import { useEffect } from 'react'
import { useConnectionAuthority,useOwnerConnectionStore } from '@/lib/connectionBridge'
import { readOwnerConnectionMetadata,peekOwnerConnectionMetadata,CONNECTIONS_CHANGED } from '@/components/connections/owner-connection-metadata'


export type PhoneIntegrations = {
  items: IntegrationMetadata[]
  /** 存没存着凭据(不联网):连没连就按它。 */
  configured: Partial<Record<string, boolean>>
  /** 每一家连上的账号(联网问,慢):还没问到 / 问不到 = null,只是少写账号名。 */
  statuses: Partial<Record<string, ConnectionStatus>> | null
  statusError?: unknown
}

/**
 * 云端连接应用:问它家里那台(与桌面资源库「集成」同一组动词 integrations.*,手机走 machineRpc 那条线)。
 * 醒着、且人在连接应用那几页(`active`)才问;每次走进来重问一遍(人可能刚在电脑上连好),重问时先留着上一次的。
 */
export function usePhoneIntegrations(machine: PhoneMachineState, active: boolean): { data: PhoneIntegrations | null; loading: boolean; error: unknown; retry: () => void } {
  const { resolvedLocale } = useLocale()
  const ready = machine.state === 'ready' ? machine.machine : null
  const authority = useConnectionAuthority(),ownerMode = authority.route?.mode === 'owner'
  const owner = useOwnerConnectionStore(null,authority.route,ownerMode)
  const panel = ownerMode ? owner : authority.route?.mode === 'legacy' ? ready?.panel : undefined
  const key = active && panel ? `integrations|${panel.ownerId}|${authority.route!.mode}|${authority.route!.epoch}|${ownerMode ? 'all' : machineKey(ready!)}|${resolvedLocale}` : null
  const read = usePhoneRead(key,() => ownerMode ? readOwnerConnectionMetadata(owner!,resolvedLocale) : readAssistantPanelIntegrations(panel!,resolvedLocale),
    'read connection metadata',undefined,() => ownerMode ? owner && peekOwnerConnectionMetadata(owner,resolvedLocale) : peekAssistantPanelIntegrations(panel,resolvedLocale))
  useEffect(() => { if (!ownerMode || !active) return; window.addEventListener(CONNECTIONS_CHANGED,read.reload)
    return () => window.removeEventListener(CONNECTIONS_CHANGED,read.reload) },[ownerMode,active,read.reload])
  const items = useAssistantIntegrationSummaries(panel,read.state === 'ok' ? read.data.items : EMPTY_INTEGRATION_SUMMARIES,resolvedLocale)
  return { data: key && read.state === 'ok' ? { ...read.data,items } : null,loading: authority.loading || !!key && read.state === 'loading',
    error: authority.error ?? (key && read.state === 'error' ? read.error : null),retry: () => { void authority.reload(); read.reload() } }
}

export function usePhoneIntegrationDetail(machine: PhoneMachineState,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const panel = machine.state === 'ready' ? machine.machine.panel : undefined
  const cached = cachedAssistantPanelIntegration(panel,summary?.id,resolvedLocale,summary?.catalogVersion)
  const read = usePhoneRead(panel && summary?.metadataOnly && !cached ? `integration-detail|${panel.ownerId}|${panel.assistantId}|${summary.id}|${summary.catalogVersion ?? ''}|${resolvedLocale}` : null,
    () => readAssistantPanelIntegration(panel!,summary!.id,resolvedLocale,summary?.catalogVersion),'read selected application',undefined,() => peekAssistantPanelIntegration(panel,summary?.id,resolvedLocale))
  return { data: summary?.metadataOnly ? cached ?? (read.state === 'ok' ? read.data : null) : summary,
    error: !cached && summary?.metadataOnly && read.state === 'error' ? read.error : null,
    loading: summary?.metadataOnly === true && !cached && read.state === 'loading',reload: read.reload }
}
