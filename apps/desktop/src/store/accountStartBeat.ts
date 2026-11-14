import { useEffect, type MutableRefObject } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { AccountRevisionCoordinator, AccountRevisionEvent, AccountRevisionListener } from '../lib/accountRevisionCoordinator'
import { watchRendererRevisionReconcile } from '../lib/accountRevisionReconcile'
import { bindBackendProbe } from '@gugu/core/cloud/backendReachability'
import { forgetUnconfirmedReads } from '../lib/readWriter'
import type { AccountImRepository } from '../lib/imRepository'
import { rendererLogger } from '../lib/log'
import { forgetMessageAgentWakes } from '../lib/messageAgentWakes'

const revisionLog = rendererLogger('chat/account-revision')
const storeLog = rendererLogger('chat/store')

/** @@@revision-registrations - consumers outlive a failed account start: each waits here until a coordinator exists. */
export type RevisionRegistration = {
  events: AccountRevisionEvent | readonly AccountRevisionEvent[]
  listener: AccountRevisionListener
  unsubscribe: (() => void) | null
}

/**
 * @@@account-start-beat - one owner for the account's reconcile beat (interval / visible / online / foreground).
 * Until the repository and coordinator have started, each beat advances that start again (a transient snapshot
 * failure is one failed step, not a dead account); afterwards it is a head-unknown wake of the revision drain.
 */
export function useAccountStartBeat(userId: string | null | undefined, ports: {
  getImRepository: () => Promise<AccountImRepository>
  getRevisionCoordinator: () => Promise<AccountRevisionCoordinator>
  coordinatorRef: MutableRefObject<AccountRevisionCoordinator | null>
  registrationsRef: MutableRefObject<Set<RevisionRegistration>>
  paintLocal: (repository: AccountImRepository) => void
  loadChats: () => Promise<unknown>
  setChats: (rows: ChatItem[]) => void
  setChatsLoad: (state: 'unread' | 'failed') => void
}): void {
  const { getImRepository, getRevisionCoordinator, coordinatorRef, registrationsRef, paintLocal, loadChats, setChats, setChatsLoad } = ports
  useEffect(() => {
    if (!userId) {
      setChats([]); setChatsLoad('unread') // 换号 / 登出:上一个号的读失败 ❌ 带到下一个号的「群」那一格
      return
    }
    let cancelled = false
    let opened = false
    const open = () => {
      if (!opened) void getImRepository()
        .then(async (repository) => {
          if (cancelled || opened) return
          opened = true
          paintLocal(repository) // initialization may have rebuilt the store from the account snapshot
          await loadChats()
        })
        .catch((err) => {
          storeLog.error({ error: err }, 'open IM repository failed')
          if (!cancelled) setChatsLoad('failed') // an empty list here is a failure, not "no conversations"
        })
    }
    open()
    const beat = () => {
      open()
      const coordinator = coordinatorRef.current
      if (coordinator) coordinator.wake()
      else if (registrationsRef.current.size > 0) void getRevisionCoordinator().catch((error) => revisionLog.error({ error }, 'coordinator failed'))
    }
    const stopBeat = watchRendererRevisionReconcile(beat)
    // A failed backend write asks for this same beat now; the beat's pull is what tells the backend came back.
    const unbindProbe = bindBackendProbe(beat)
    // Reads this account could not write, and wakes it read, are this account's: they never carry over to the next one.
    return () => { cancelled = true; stopBeat(); unbindProbe(); forgetUnconfirmedReads(); forgetMessageAgentWakes() }
  }, [coordinatorRef, getImRepository, getRevisionCoordinator, loadChats, paintLocal, registrationsRef, setChats, setChatsLoad, userId])
}
