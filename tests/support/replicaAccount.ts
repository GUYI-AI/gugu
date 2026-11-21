import { notifyManager } from '@tanstack/react-query'

/**
 * A renderer that just signed `userId` in, with nothing read yet: replica answers are published at once (as the
 * app's frames see them), the cache is empty and the replica's account is `userId` (what the session publication does).
 */
export async function freshReplicaAccount(userId: string): Promise<typeof import('../../apps/desktop/src/lib/replica')> {
  notifyManager.setScheduler((callback) => { callback() })
  const replica = await import('../../apps/desktop/src/lib/replica')
  replica.queryClient.clear()
  replica.followRendererSession('SIGNED_IN', userId)
  return replica
}
