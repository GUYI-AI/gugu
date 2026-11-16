import { replica, useReplica } from '../lib/replica'
import { parseSessionpageAgentContext, type SessionpageAgentContext } from '../lib/sessionpageAgentProjection'
import { desktopIpc } from '../platform/desktopIpc'

// @@@3911 投影自带主体 —— keyed by the agent, so switching agents ❌ shows the previous agent's answer (#3911).
//
// 这份投影只答「这个 agent 映射到会话页哪条会话」与只在会话面显形的平台恢复。它的状态、审阅门、provider
// 阻塞是宿主按 agent 的流里的读数(agentPresenceStore 的 `local`),❌ 在这里再订一遍会话页的按会话通道 ——
// 同一件事两条通道,就会给出两个答案。
type ProjectionSubject = { agentUserId: string | null }

type ProjectionState = (
  | { kind: 'disabled' | 'pending' | 'unmapped'; context: null; error: null }
  | { kind: 'mapped'; context: SessionpageAgentContext; error: null }
  | { kind: 'error'; context: SessionpageAgentContext | null; error: string }
) & ProjectionSubject

/** Which task-page session an agent maps to here, with its platform recovery (null = not mapped). Host-pushed. */
export const agentSessionContext = replica({
  name: 'agentSessionContext',
  scope: 'device',
  read: async (_owner, agentUserId: string): Promise<SessionpageAgentContext | null> => {
    const api = desktopIpc()
    if (!api) throw new Error('session-page agent context: no desktop main process here')
    return parseSessionpageAgentContext(await api.invoke('sessionpage:agent-context', agentUserId))
  },
  fresh: Infinity,
  watch: {
    start: () => {
      const api = desktopIpc()!
      // 任务页换了展示(编程 ⇄ 通用):宿主播 session:changed,带 runtime。私聊头部模式按钮的「使用中」跟着换。
      const offView = api.eventOn('session:changed', (value) => {
        const runtime = (value as { changes?: { runtime?: unknown } } | null)?.changes?.runtime
        if (runtime !== undefined) void agentSessionContext.refresh()
      })
      const offRecovery = api.eventOn('session:platform-recovery-changed', () => { void agentSessionContext.refresh() })
      return () => { offView(); offRecovery() }
    },
  },
})

export function useSessionpageAgentProjection(agentUserId: string | null): ProjectionState {
  const enabled = agentUserId !== null && desktopIpc() !== null
  const reading = useReplica(agentSessionContext, enabled ? [agentUserId] : null)
  if (!enabled) return { kind: 'disabled', context: null, error: null, agentUserId }
  if (reading.state === 'unknown') return { kind: 'pending', context: null, error: null, agentUserId }
  if (reading.state === 'error') return { kind: 'error', context: null, error: reading.error.message, agentUserId }
  const context = reading.value
  if (reading.error) return { kind: 'error', context, error: reading.error.message, agentUserId }
  if (!context) return { kind: 'unmapped', context: null, error: null, agentUserId }
  if (context.projectionError) return { kind: 'error', context, error: context.projectionError, agentUserId }
  return { kind: 'mapped', context, error: null, agentUserId }
}
