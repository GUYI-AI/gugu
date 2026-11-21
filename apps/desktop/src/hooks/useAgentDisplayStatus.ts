import { useCallback, useEffect, useMemo, useState } from 'react'
import { openLink } from '../lib/guguLinks'
import { useToast } from '../components/toastContext'
import {
  agentPresenceReadable,
  getAgentPresenceSnapshot,
  subscribeAgentPresence,
} from '../lib/agentPresenceStore'
import { useSelect, type Readable } from '../lib/selectStore'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'

// 这些 hook 是那张 agent 状态表的**选择器**,一个 agent 一个答案 —— ❌ 没有「按会话」这一维:
// 从前这里把 store 的态按 presence.activeChatId 再收口一次,于是权威点名了哪条会话,
// 只有那一面说真话、其余每一面说空闲(owner 2026-09-11 报的「群里工作中、单聊空闲」)。

// @@@unified-presence-hook - Thin selector over AgentPresenceStore. The store handles transport, fusion,

// @@@3839 C — 单数与批量 hook 读同一个 store(经 `agentPresenceReadable` / `useSelect`):首帧就是 store 里存着的那一条,
// 换 agent 时同一次渲染就换成新 agent 的那一条;「没观测过长什么样」由 store 单点定义。
export function useAgentDisplayStatus(agentUserId: string | null | undefined) {
  const { toast } = useToast()
  const state = useSelect(agentPresenceReadable(agentUserId ?? ''), (presence) => presence, Object.is)
  const [opening, setOpening] = useState(false)

  // @@@acp-no-wake (#1099) - ACP 下 agent = spawn+stdio,设备在线即可触达、发消息自动启动该会话;
  // 不存在 terminal 时代「先唤醒再用」的机制。原 wake() 动作 + chatService.wakeAgent 已删。
  const openRuntime = useCallback(async () => {
    if (!agentUserId || opening) return
    setOpening(true)
    try {
      // 打开 agent 的会话只有一条路(本机的、别的机器上的都一样)。
      await openLink({ kind: 'session', agentId: agentUserId })
      toast(i18n.t('chatService.runtimeOpen.opened', { ns: 'messaging' }), 'info')
    } catch (err) {
      toast(String((err as Error)?.message ?? err), 'error')
    } finally {
      setOpening(false)
    }
  }, [agentUserId, opening, toast])

  return {
    status: state.status,
    presence: state,
    opening,
    openRuntime,
  }
}

// @@@batched-presence-hook - One stable subscription per agent ID; aggregated map for surfaces that render N agents.
// Used by group panel and any future chat-list badges. Re-subscribes only when the ID set changes.
export function useAgentDisplayStatuses(
  agentUserIds: readonly string[],
): Record<string, AgentDisplayStatus> {
  // @@@stable-ids-key (#514) - derive the subscription key from the agent-id VALUES, not the input
  const idsKey = useMemo(
    () => Array.from(new Set(agentUserIds.filter(Boolean))).sort().join(','),
    [agentUserIds],
  )
  const stableIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const presences = useMemo<Readable<readonly string[]>>(() => ({
    get: () => stableIds,
    subscribe: (listener) => {
      const offs = stableIds.map((id) => subscribeAgentPresence(id, () => listener()))
      return () => { for (const off of offs) off() }
    },
  }), [stableIds])
  // Batch consumers are aggregate/group surfaces. Pending is not a resolved member state: it stays absent until a
  // snapshot or event arrives, instead of flashing a false group dot.
  const statuses = useSelect(presences, (ids) => {
    const resolved: Record<string, AgentDisplayStatus> = {}
    for (const id of ids) {
      const snapshot = getAgentPresenceSnapshot(id)
      if (snapshot && snapshot.source !== 'pending') resolved[id] = snapshot.status
    }
    return resolved
  })

  return statuses
}

// @@@group-recent-activity (#518/#437) - per-agent recent-action data for the avatar pop-out (group bar +
export interface AgentRecentActivity {
  actions: string[]
  lastActiveAt: string | null
}

export function useAgentRecentActivity(
  agentUserIds: readonly string[],
): Record<string, AgentRecentActivity> {
  const idsKey = useMemo(
    () => Array.from(new Set(agentUserIds.filter(Boolean))).sort().join(','),
    [agentUserIds],
  )
  const stableIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const [activity, setActivity] = useState<Record<string, AgentRecentActivity>>(() => {
    const initial: Record<string, AgentRecentActivity> = {}
    for (const id of stableIds) {
      const payload = getAgentPresenceSnapshot(id)?.payload
      initial[id] = { actions: payload?.recentActions ?? [], lastActiveAt: payload?.lastActionAt ?? null }
    }
    return initial
  })

  useEffect(() => {
    if (stableIds.length === 0) {
      setActivity({})
      return
    }
    setActivity((prev) => {
      const next: Record<string, AgentRecentActivity> = {}
      for (const id of stableIds) {
        const payload = getAgentPresenceSnapshot(id)?.payload
        next[id] = payload
          ? { actions: payload.recentActions ?? [], lastActiveAt: payload.lastActionAt ?? null }
          : prev[id] ?? { actions: [], lastActiveAt: null }
      }
      return next
    })
    const unsubs = stableIds.map((id) =>
      subscribeAgentPresence(id, (state) => {
        const next: AgentRecentActivity = {
          actions: state.payload?.recentActions ?? [],
          lastActiveAt: state.payload?.lastActionAt ?? null,
        }
        setActivity((prev) => (sameActivity(prev[id], next) ? prev : { ...prev, [id]: next }))
      }),
    )
    return () => {
      for (const off of unsubs) off()
    }
  }, [idsKey, stableIds])

  return activity
}

function sameActivity(a: AgentRecentActivity | undefined, b: AgentRecentActivity): boolean {
  if (!a || a.lastActiveAt !== b.lastActiveAt) return false
  return sameSeq(a.actions, b.actions)
}

function sameSeq(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
