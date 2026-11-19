import { removeAgents } from '@gugu/core/local/state/agents'
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner'
import type { AccountClosureScope } from '../../src/platform/accountClosure'
import { scopeOf } from './receipts'

/** Internal local-data step, after the native service has checked its captured
 * receipt, owner fence and runtime exit proof. This does not remove a cloud
 * identity or create a retained identity tombstone. Unknown ownership stays. */
export async function eraseClosedAccountRoster(input: AccountClosureScope, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const scope = scopeOf(input)
  await removeAgents(agent => agentOwnerUserId(agent) === scope.ownerId, env)
}
