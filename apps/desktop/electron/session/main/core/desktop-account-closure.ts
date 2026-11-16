import { join } from 'node:path'
import { app } from 'electron'
import { listAgents, removeAgents } from '@gugu/core/local/state/agents'
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner'
import { removeAgentRuntimeSession } from '@gugu/core/local/agent/agentRuntimeSession'
import { clearHumanAuthSession, readHumanAuthSession } from '@gugu/core/local/identity/humanAuthSession'
import { privatePasswordVaultDirectory } from '@gugu/core/local/state/protectedPrivateStorage'
import { createDesktopClosureService } from '../../../account-closure/service'
import { ClosureFailure } from '../../../account-closure/receipts'
import { removeClosureOwnerDirectory } from '../../../account-closure/owner-directory'
import { assertNoLiveAccountEngines } from '../../../account-closure/foreign-runtimes'
import { closePasswordVaultForAccountClosure } from '../../../password-vault/beta-host'
import { encryptedAppSecretsStore } from './secrets/encrypted-app-secrets-store'
import { imMessagesController } from './im-messages/controller'
import { flushLogWrites, setLogFileOwner } from '../lib/file-logger'

interface NativeHost {
  currentOwner(): Promise<string | null | undefined>
  stopOwner(ownerId: string): Promise<void>
  detachMainLog(ownerId: string): Promise<string[]>
  clearAuthMirror(ownerId: string): Promise<void>
  profileBinding: string
}

/** Exported by the existing backend bundle. The protected secrets and message
 * store are the same instances as the rest of that bundle, never a second DB. */
export function createDesktopAccountClosureHost(host: NativeHost) {
  return createDesktopClosureService({
    profileBinding: host.profileBinding,
    secrets: encryptedAppSecretsStore,
    currentOwner: host.currentOwner,
    stopOwner: host.stopOwner,
    recheckStopped: assertNoLiveAccountEngines,
    steps: [
      { name: 'account-message-cache', async run(scope) {
        imMessagesController.clearAccount(scope.ownerId)
        return true
      } },
      { name: 'account-agent-credentials', async run(scope) {
        const agents = (await listAgents(process.env, { includeGuests: true })).filter(agent => agentOwnerUserId(agent) === scope.ownerId)
        // Keep the roster attribution until every token is removed. A failed
        // deletion can then repeat after a crash without losing its owner key.
        for (const agent of agents) if (agent.gugu_user_id) {
          if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(agent.gugu_user_id)) throw new ClosureFailure('closure_storage_unavailable')
          await removeAgentRuntimeSession(agent.gugu_user_id)
        }
        return true
      } },
      { name: 'account-password-vault', async run(scope) {
        await closePasswordVaultForAccountClosure(scope.ownerId)
        await removeClosureOwnerDirectory(privatePasswordVaultDirectory(), scope.ownerId)
        return true
      } },
      { name: 'account-diagnostic-logs', async run(scope) {
        const mainRoots = await host.detachMainLog(scope.ownerId)
        const target = setLogFileOwner(null)
        const root = join(app.getPath('userData'), 'logs')
        // Explicit custom log destinations have no account attribution. Retain
        // those; only the fixed native account directory is erased here.
        if (target?.startsWith(join(root, 'users', scope.ownerId) + '/')) throw new ClosureFailure('closure_storage_unavailable')
        await flushLogWrites()
        for (const directory of new Set([join(root, 'users'), ...mainRoots])) await removeClosureOwnerDirectory(directory, scope.ownerId)
        return true
      } },
      { name: 'account-login-mirror', async run(scope) {
        const mirror = await readHumanAuthSession()
        if (mirror && mirror.user_id !== scope.ownerId) throw new ClosureFailure('wrong_local_owner')
        if (mirror) await clearHumanAuthSession()
        await host.clearAuthMirror(scope.ownerId)
        return true
      } },
      { name: 'account-agent-roster', async run(scope) {
        await removeAgents(agent => agentOwnerUserId(agent) === scope.ownerId)
        return true
      } },
    ],
    retained: async () => ['workspace-files', 'unattributed-session-history', 'device-settings', 'provider-credentials', 'unattributed-diagnostic-logs', 'unattributed-runtime-records'],
  })
}
