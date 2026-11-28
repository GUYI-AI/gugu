import { configuredIntegrationIndex } from '../integrations/integration-resource-index'
import { integrationAccountSignature,panelIntegrationChecks } from './assistant-panel-integration-checks'
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance'
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { buildIntegrationListPayload } from '@main/core/integrations/integration-payload-builder'
import { integrationConnectionService } from '@main/core/integrations/integration-connection-service'
import { setOwnerConnectionControl } from '@main/core/integrations/owner-connection-control'
import { platformCredentials } from '@main/core/integrations/platform-credentials-instance'

/** This bridge lives in the embedded module, beside the actual registries and
 * scheduler. The Electron host must not construct a second copy of either. */
export const assistantPanelLocal = {
  setOwnerConnectionControl,
  integrationIndex: configuredIntegrationIndex,
  integrationCustody(providerId: string) { return platformCredentials.custody(providerId) },
  onIntegrationsChanged(listener: () => void) { return providerAccountRegistry.onChanged(listener) },
  async integrations(ownerId: string,onVerified?: () => void) {
    // #921 credentials the platform keeps: what another device connected or disconnected shows here too.
    await platformCredentials.refresh({ maxAgeMs: 60_000 })
    return (await Promise.all(integrationPluginRegistry.getAll().map(async plugin => {
      const providerId = plugin.metadata.id
      const accounts = await providerAccountRegistry.listAccounts(providerId)
      const verified = panelIntegrationChecks(providerId,integrationAccountSignature(accounts),ownerId,onVerified)
      return accounts.map(account => {
        const check = verified && verified.checkedAt >= account.updatedAt ? verified.checks.find(check => check.accountId === account.accountId) : undefined
        return {
          ...(check ? { checkResult: check.connected ? 'ok' : check.errorType === 'authorization_expired' || check.errorType === 'key_rejected' ? 'reauth' : 'failed',checkedAt: verified!.checkedAt } : {}),
          providerId,accountId: account.accountId,configured: true,isDefault: account.isDefault,
          displayName: account.meta?.displayName ?? account.meta?.login,
          publicMetadata: { version: 1,providerId,accountId: account.accountId,isDefault: account.isDefault,
            connectedAt: account.createdAt,updatedAt: account.updatedAt,host: account.meta?.host,login: account.meta?.login,
            avatarUrl: account.meta?.avatarUrl,credentialSource: account.meta?.credentialSource,displayName: account.meta?.displayName,
          },
        }
      })
    }))).flat()
  },
  integrationCatalog() {
    const custodyOf = (id: string) => platformCredentials.custody(id)
    const en = buildIntegrationListPayload('en-US',custodyOf), zh = buildIntegrationListPayload('zh-CN',custodyOf)
    return en.map(item => ({ id: item.id,en: item,zh: zh.find(row => row.id === item.id)! }))
  },
  /** Owner device-scope effects never revoke the separate platform credential.
   * The runtime checks owner/device admission before entering this bridge. */
  async applyConnection(input: { operation: string; data: Record<string, unknown> }) {
    const { data,operation } = input
    const refuse = (code: string): never => { throw Object.assign(new Error(code),{ code,knownNoEffect: true }) }
    if (typeof data.providerId !== 'string' || typeof data.accountId !== 'string') refuse('CONNECTION_DATA_INVALID')
    const providerId = data.providerId as string,accountId = data.accountId as string
    if (!integrationPluginRegistry.get(providerId)) refuse('CONNECTION_PROVIDER_UNSUPPORTED')
    if (operation === 'remove') { await integrationConnectionService.disconnectLocalAccount(providerId,accountId); return }
    if (operation === 'save') {
      if (!(await providerAccountRegistry.listAccounts(providerId)).some(row => row.accountId === accountId)) refuse('CONNECTION_AUTHORIZATION_REQUIRED')
      if (data.isDefault === true) await providerAccountRegistry.setDefaultAccount(providerId,accountId)
      return
    }
    refuse('CONNECTION_OPERATION_UNSUPPORTED')
  },
}
