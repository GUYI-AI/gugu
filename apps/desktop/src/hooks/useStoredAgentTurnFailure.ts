import { useCallback, useEffect, useState } from 'react'
import { readStoredAgentTurnFailures, type StoredAgentTurnFailure, type StoredFailureScope } from '../lib/storedAgentTurnFailures'
import { readAgentTurnFailureDismissals, writeAgentTurnFailureDismissals, type AgentTurnFailureDismissals } from '../lib/agentTurnFailureDismissals'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '../lib/realtimeChannel'
import { rendererLogger } from '../lib/log'
import { subscribeBackendRecovered } from '@gugu/core/cloud/backendReachability'
import { useAuth } from '../store/auth'
import { replica, useReplica } from '../lib/replica'

const log = rendererLogger('agent/stored-turn-failure')

/** Agents' persisted turn failures per scope and agent set. Signal tier; a failed read is retried with backoff (1 s … 30 s). */
export const storedAgentTurnFailures = replica({
  name: 'storedAgentTurnFailures',
  scope: 'account',
  read: async (_owner: string, scopeKey: string, idsKey: string): Promise<StoredAgentTurnFailure[]> => {
    try {
      return (await readStoredAgentTurnFailures(JSON.parse(scopeKey) as StoredFailureScope, idsKey ? idsKey.split(',') : [])).failures
    } catch (error) {
      log.error({ scope: JSON.parse(scopeKey) as StoredFailureScope, error: String(error) }, 'could not read agent reply outcome')
      throw error
    }
  },
  retry: true,
  retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
})

function loadDismissals(userId: string | undefined): AgentTurnFailureDismissals {
  if (!userId) return {}
  try {
    return readAgentTurnFailureDismissals(userId)
  } catch (error) {
    // 读坏了就等于没关过：失败条再出现一次，原因进日志。
    log.error({ error: String(error) }, 'could not read dismissed agent turn failures')
    return {}
  }
}

export const AGENT_DELIVER_CHANGED = 'agent_deliver_changed'

/** 宿主本机事件之外，从同一条命令的持久结果读失败；私有广播只提示失效，不广播错误原文。 */
export function useStoredAgentTurnFailure(scope: StoredFailureScope | null, agentIds: readonly string[]) {
  const { user } = useAuth()
  const ids = [...new Set(agentIds)].sort().join(',')
  const scopeKey = scope === null ? null : JSON.stringify(scope)
  // 关掉记在本机存储里（按命令、按那一版），❌ 只记在组件里：切走再回来、重开 App 都还认得（owner 10-28 Codex 91）。
  const [dismissals, setDismissals] = useState<{ userId: string | undefined; value: AgentTurnFailureDismissals }>(() => ({ userId: user?.id, value: loadDismissals(user?.id) }))
  const currentDismissals = dismissals.userId === user?.id ? dismissals.value : loadDismissals(user?.id)
  const changeDismissals = useCallback((change: (now: AgentTurnFailureDismissals) => AgentTurnFailureDismissals | null) => {
    if (!user?.id) return
    const next = change(loadDismissals(user.id))
    if (!next) return
    try {
      writeAgentTurnFailureDismissals(user.id, next)
    } catch (error) {
      log.error({ error: String(error) }, 'could not save dismissed agent turn failures')
    }
    setDismissals({ userId: user.id, value: next })
  }, [user?.id])
  // A chat with no agent left can still owe its owner a notice about one that was removed; the task page reads only its own.
  const asks = !!user?.id && scopeKey !== null && !(scope === 'any-chat' && !ids)
  const reading = useReplica(storedAgentTurnFailures, asks && scopeKey !== null ? [scopeKey, ids] : null)
  const read = reading.state === 'value' ? reading.value : null
  // A reading's failures that were dismissed before their revision was known: the dismissal now names that revision.
  useEffect(() => {
    if (!read) return
    changeDismissals((now) => {
      const pending = read.filter((row) => now[row.commandId]?.revision === null)
      return pending.length ? { ...now, ...Object.fromEntries(pending.map((row) => [row.commandId, { revision: row.revision, at: Date.now() }])) } : null
    })
  }, [read, changeDismissals])
  // Only the status is reread: a failed read never resends an agent's command.
  useEffect(() => {
    if (!asks || !user?.id || scopeKey === null) return
    const where = JSON.parse(scopeKey) as StoredFailureScope
    const refresh = () => { void storedAgentTurnFailures.refresh(scopeKey, ids) }
    // The first subscribed notice follows the mount's own read (❌ every open read twice); later ones (resubscribed) read.
    let opened = true
    const subscribed = () => {
      const first = opened
      opened = false
      if (first && storedAgentTurnFailures.peek(scopeKey, ids).state === 'unknown') return
      refresh()
    }
    const handle = subscribePrivateUserEventBus(user.id, AGENT_DELIVER_CHANGED, (raw) => {
      if (!raw || typeof raw !== 'object') return
      const event = raw as Record<string, unknown>
      if (where !== 'any-chat' && (event.chat_id !== where.chatId || (event.thread_root_id || null) !== where.threadRootId)) return
      if (typeof event.agent_user_id !== 'string' || (where === 'any-chat' && !ids.split(',').includes(event.agent_user_id))) return
      const settled = typeof event.id === 'string' && event.status !== 'error' ? event.id : null
      if (settled) changeDismissals((now) => {
        if (!(settled in now)) return null
        const rest = { ...now }
        delete rest[settled]
        return rest
      })
      refresh()
    }, { onSubscribed: subscribed })
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    const stopRecovered = subscribeBackendRecovered(refresh) // the backend came back: read the failure rows again
    document.addEventListener('visibilitychange', visible)
    return () => {
      unsubscribePrivateUserEventBus(handle)
      window.removeEventListener('focus', refresh)
      stopRecovered()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [asks, user?.id, scopeKey, ids, changeDismissals])

  const dismiss = useCallback((commandId: string) => {
    const revision = read?.find((row) => row.commandId === commandId)?.revision ?? null
    changeDismissals((now) => ({ ...now, [commandId]: { revision, at: Date.now() } }))
  }, [read, changeDismissals])
  return {
    // Not read yet (or unreadable, retried with backoff): no failure is shown — this is a notice, not a list.
    failure: read ? read.find((row) => currentDismissals[row.commandId]?.revision !== row.revision) ?? null : null,
    dismiss,
  }
}
