import type { ChatChannelKind } from '@gugu/core/cloud/chatChannels'
import { refreshFailure, type Reading } from '@/lib/replica'
import type { ChatChannelsValue } from '@/components/connections/connection-replicas'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectorState } from '@/session/renderer/features/assistant/assistant-connector-status'
import type { IntegrationCatalogMetadata } from '@gugu/session-plugins/integration-summaries'

export type ApplicationConnectionState = ConnectorState | 'paused' | 'retrying'
export type AssistantConnectedApp = { id: string; name: string; description: string; integration?: IntegrationMetadata; state: ApplicationConnectionState; saved: boolean; catalog?: IntegrationCatalogMetadata; connectionStatus?: string }

/** Legacy snapshots used the internal default credential key as an account name. */
export function assistantAccountDisplayName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name !== 'default' ? name : null
}

/**
 * Normalize each provider's real connection state before displaying, counting or sorting apps. The chat channels are the
 * `chatChannels` reading: not read yet and unreadable (or a read again failing) are not "not connected"; no cloud computer (`absent`) is none.
 */
export function assistantConnectedApps(items: readonly IntegrationMetadata[], services: Reading<ChatChannelsValue>,
  applicationName: (id: ChatChannelKind) => string, wechatDescription: string,
  stateFor: (id: string) => ConnectorState = () => 'notConnected', configured: Record<string, boolean | undefined> = {}): AssistantConnectedApp[] {
  const apps = new Map(items.map(integration => [integration.id, { id: integration.id, name: integration.name,
    description: integration.description ?? '', catalog: integration.catalog,
    integration, state: stateFor(integration.id), saved: !!configured[integration.id] } as AssistantConnectedApp]))
  const connection = services.state === 'value' && !('absent' in services.value)
    ? services.value.channels.find(item => item.kind === 'wechat') : undefined
  const health = connection?.health.state
  // Unreadable, or read before and its read again failing: the health read before is not known now (❌ drawn as current).
  const failed = refreshFailure(services) !== null
  apps.set('wechat', { id: 'wechat', name: applicationName('wechat'), description: wechatDescription,
    catalog: { categoryId: 'mail', aliases: ['WeChat', '微信', 'weixin'] },
    saved: !!connection, state: failed ? 'checkFailed' : health === 'running' ? 'connected' : health === 'starting' ? 'checking'
      : health === 'paused' ? 'paused' : health === 'retrying' ? 'retrying' : connection ? 'checkFailed'
      : services.state === 'unknown' ? 'checking' : 'notConnected' })
  return [...apps.values()]
}

export function assistantApplicationCounts(items: readonly IntegrationMetadata[], configured: Record<string, boolean | undefined>,
  statuses: Record<string, { connected: boolean } | undefined> | null | undefined, services: ChatChannelsValue) {
  // Counted only once the channels are read (a list, or `absent`: no cloud computer, so none).
  const apps = assistantConnectedApps(items, { state: 'value', value: services, stale: false, error: null }, id => id, '', id => statuses?.[id]?.connected ? 'connected' : 'unverified', configured)
  return { connected: apps.filter(app => app.state === 'connected').length, saved: apps.filter(app => app.saved).length }
}
