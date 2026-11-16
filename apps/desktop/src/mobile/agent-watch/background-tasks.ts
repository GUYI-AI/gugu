import { metadataSeparator } from '@/i18n/format'
import { useMemo } from 'react'
import {
  collectBackgroundCommandRoster,
  collectSubagentRoster,
  type BackgroundCommandEntry,
  type SubagentRegistryEntry,
  type SubagentRosterEntry,
} from '@gugu/session-chat-ui/background-rosters'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { isSubagentDismissed } from '@renderer/features/sessions/view/subagent-dismissals'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { rendererLogger } from '@/lib/log'
import { fetchBackgroundTasks } from './sessionpage-rpc'
import { replica, useReplica } from '@/lib/replica'
import { assistantTimelineClient } from '@/components/assistant/assistantTimelineClient'

const log = rendererLogger('mobile/agent-watch/background-tasks')

/** 名单还在时多久再问一次那台机器「哪些命令还活着」:命令跑完、进程没了都不会往时间线里写一行。 */
export const BACKGROUND_TASKS_POLL_MS = 5000

export type PhoneBackgroundTasks = {
  commands: BackgroundCommandEntry[]
  subagents: SubagentRosterEntry[]
  /** 那台电脑接得住停止(新版主机);老版本 = false,单子上不画停止键。 */
  canStop: boolean
}

/**
 * 手机看会话末尾那一句的两份名单(#638 搬到手机):与桌面消息列表末尾那一行同一对 `collect*Roster`,
 * 读的是手机手里这份时间线。时间线里最后一轮还开着时,它就是那一轮(桌面的 activeTurn)。
 * 命令名单再过一道运行时的筛子(#6582):旧轮里的命令可能随上一个进程没了,终态永远不会来。
 */
export function backgroundTaskRosters(
  sessionId: string,
  turns: readonly TranscriptTurn[],
  runningCommandTaskIds: readonly string[] | null,
  /** Running subagents' own calls from the timeline (#2500); they are not inside the turns. */
  subagentSteps: readonly SubagentRegistryEntry[] = [],
): { commands: BackgroundCommandEntry[]; subagents: SubagentRosterEntry[] } {
  const last = turns.at(-1)
  const active = last && !last.outcome ? last : null
  const committed = active ? turns.slice(0, -1) : turns
  const shown = <T extends { id: string }>(rows: T[]) => rows.filter((row) => !isSubagentDismissed(sessionId, row.id))
  return {
    commands: shown(collectBackgroundCommandRoster(committed, active, translateSessionMessage('transcript.backgroundCommand'), runningCommandTaskIds,
      subagentSteps.flatMap((entry) => entry.steps ?? []))),
    subagents: shown(collectSubagentRoster(committed, active, translateSessionMessage('transcript.subagent'), Date.now(), subagentSteps)),
  }
}

/**
 * Which of a session's background tasks its machine still runs (this computer's own runtime when `local`). No push: asked
 * every BACKGROUND_TASKS_POLL_MS while a surface shows a candidate that may be running.
 */
export const sessionBackgroundTasks = replica({
  name: 'sessionBackgroundTasks',
  scope: 'account',
  read: async (_owner: string, deviceId: string, sessionId: string, local: boolean): Promise<{ runningCommandTaskIds: string[] | null }> => {
    try {
      return await (local ? assistantTimelineClient(true).fetchBackgroundTasks!(deviceId, sessionId) : fetchBackgroundTasks(deviceId, sessionId))
    } catch (error) {
      log.info({ error: String(error), deviceId }, 'that computer cannot report its running background tasks')
      throw error
    }
  },
  fresh: 0,
  refreshEvery: BACKGROUND_TASKS_POLL_MS,
})

/**
 * `dismissals`:人按过 × 就加一,让名单重算(收起表是 mobx 的,React 这边不订它)。
 * `local`:问本机的运行时(本机会话),否则经 sessionpage RPC 问那台机器。
 */
export function usePhoneBackgroundTasks(
  deviceId: string,
  sessionId: string,
  turns: readonly TranscriptTurn[],
  dismissals: number,
  enabled: boolean,
  subagentSteps: readonly SubagentRegistryEntry[],
  local = false,
): PhoneBackgroundTasks {
  // 先不筛地算一遍:有没有东西可能在跑,决定要不要去问那台机器。
  const candidates = useMemo(() => (enabled ? backgroundTaskRosters(sessionId, turns, null, subagentSteps) : { commands: [], subagents: [] }), [enabled, sessionId, turns, dismissals, subagentSteps]) // eslint-disable-line react-hooks/exhaustive-deps -- dismissals re-reads the mobx dismissal set
  const asking = candidates.commands.length + candidates.subagents.length > 0
  const reading = useReplica(sessionBackgroundTasks, asking ? [deviceId, sessionId, local] : null)
  return useMemo(() => {
    if (!asking) return { commands: [], subagents: [], canStop: false }
    // Not answered yet, or that computer cannot tell (now: its last answer is not what runs now): every candidate is
    // listed unfiltered and nothing offers a stop key.
    if (reading.state !== 'value' || reading.error) return { commands: candidates.commands, subagents: candidates.subagents, canStop: false }
    const ids = reading.value.runningCommandTaskIds
    const commands = ids === null ? candidates.commands : candidates.commands.filter((entry) => ids.includes(entry.taskId))
    return { commands, subagents: candidates.subagents, canStop: true }
  }, [asking, candidates, reading])
}

/** 「后台 · 2 条命令 · 1 个子智能体」:与桌面那一行同一组文案键。 */
export function backgroundTasksLabel(commandCount: number, agentCount: number): string {
  const parts: string[] = []
  if (commandCount > 0) parts.push(translateSessionMessage(commandCount === 1 ? 'transcript.backgroundTasks.commandsOne' : 'transcript.backgroundTasks.commands', { count: commandCount }))
  if (agentCount > 0) parts.push(translateSessionMessage(agentCount === 1 ? 'transcript.backgroundTasks.subagentsOne' : 'transcript.backgroundTasks.subagents', { count: agentCount }))
  return translateSessionMessage('transcript.backgroundTasks.label', { parts: parts.join(metadataSeparator()) })
}
