import { useMemo } from 'react'
import { useMobileShell } from '@/hooks/useMobileShell'
import { useAgentSession } from '@/lib/projectGroupChatsBridge'
import type { AgentSession } from '@/session/renderer/features/projects/stores/project-group-chats-bridge'
import { useDevicesStore } from '@/store/devicesContext'
import { directoryRows, useLiveDeviceSessions, type SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

/**
 * 这个 agent 是哪台机器上的哪条会话(#7197):从手机现有的会话目录里找(行上带 agent 的 id),❌ 另问一遍。
 * 一个 agent 有好几行(换过机器、旧会话还在目录里)时取最近交互的那一行(同 #658「an agent row opens its latest
 * session」),❌ 目录里排第一的那行:手机资料卡、助理进度、私聊页头的模式按钮说的都是它此刻那条会话。
 * null = 找不到(不是某台机器上的会话、或账号下没有它)—— 私聊页头就不放模式按钮,与桌面「解析不到就不渲染」同一条;
 * agentUserId 为 null = 不找。
 */
export function useAgentSessionRow(agentUserId: string | null): SessionDirectoryRow | null {
  const { devices } = useDevicesStore()
  const live = useLiveDeviceSessions()
  return useMemo(() => (agentUserId ? latestAgentSessionRow(directoryRows(devices, live), agentUserId) : null), [agentUserId, devices, live])
}

/** The agent's most recently used session among the directory rows (`lastInteractedAt`), or null. */
export function latestAgentSessionRow(rows: readonly SessionDirectoryRow[], agentUserId: string): SessionDirectoryRow | null {
  let latest: SessionDirectoryRow | null = null
  for (const row of rows) {
    if (row.session.agent?.userId !== agentUserId) continue
    if (!latest || (row.session.lastInteractedAt ?? '') > (latest.session.lastInteractedAt ?? '')) latest = row
  }
  return latest
}

/**
 * The session an agent's entry opens (its profile card's 发消息, a running pill's card): on a computer the session bridge
 * the task bundle publishes; a phone has no such bundle and finds it in its session directory (#673, #658). undefined =
 * none found, so the entry is not offered. agentUserId null = do not look.
 */
export function useAgentSessionEntry(agentUserId: string | null): AgentSession | undefined {
  const phone = useMobileShell()
  const bridged = useAgentSession(!phone ? agentUserId : null)
  const row = useAgentSessionRow(phone ? agentUserId : null)
  return phone ? (row ? { projectId: row.session.projectId, sessionId: row.session.conversationId } : undefined) : bridged
}
