import { EMPTY_INTEGRATION_SUMMARIES,useAssistantIntegrationSummaries } from '@/components/assistant/useAssistantIntegrationSummaries'
import { useLocale } from '@/i18n'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import { assistantIntegrationDetail,connectionList,useAssistantIntegrationDetail,useConnectionList } from '@/components/assistant/assistant-panel-reads'
import type { PhoneMachineState } from './phoneMachine'
import { useConnectionAuthority,useOwnerConnectionStore } from '@/lib/connectionBridge'
import { refreshFailure } from '@/lib/replica'


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
 * 人在连接应用那几页(`active`)才读(replica `connectionList`,连接那一份变了 / 面板变了就再读;再读时照旧摆着上一次的)。
 * `error` 也是再读失败、上一次的还摆着的那种(`data` 照旧给):画的人在旁边说一句(❌ 当成现在的)。
 */
export function usePhoneIntegrations(machine: PhoneMachineState, active: boolean): { data: PhoneIntegrations | null; loading: boolean; error: unknown; retry: () => void } {
  const { resolvedLocale } = useLocale()
  const ready = machine.state === 'ready' ? machine.machine : null
  const authority = useConnectionAuthority(),ownerMode = authority.route?.mode === 'owner'
  const owner = useOwnerConnectionStore(null,authority.route,ownerMode)
  const panel = ownerMode ? owner : authority.route?.mode === 'legacy' ? ready?.panel : undefined
  const reading = useConnectionList(panel,ownerMode,resolvedLocale,active)
  const listed = reading.state === 'value' ? reading.value : null
  const items = useAssistantIntegrationSummaries(panel,listed ? listed.items : EMPTY_INTEGRATION_SUMMARIES,resolvedLocale)
  const shown = active && !!panel
  return { data: shown && listed ? { ...listed,items } : null,loading: authority.loading || shown && reading.state === 'unknown',
    error: authority.error ?? (shown ? refreshFailure(reading) : null),
    retry: () => { void authority.reload(); void connectionList.refresh() } }
}

/** The opened application's full catalog entry (replica `assistantIntegrationDetail`); a full summary is itself. `error` with `data`: a refresh failed over it. */
export function usePhoneIntegrationDetail(machine: PhoneMachineState,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const panel = machine.state === 'ready' ? machine.machine.panel : undefined
  const { summaryIsFull, reading } = useAssistantIntegrationDetail(panel,summary,resolvedLocale)
  return { data: summaryIsFull ? summary : reading.state === 'value' ? reading.value : null,
    error: summaryIsFull ? null : refreshFailure(reading),
    loading: !summaryIsFull && !!panel && reading.state === 'unknown',
    reload: () => { void assistantIntegrationDetail.refresh() } }
}
