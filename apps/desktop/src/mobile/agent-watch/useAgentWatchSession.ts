import * as sessionpageRpc from './sessionpage-rpc'
import { useTimelineSession, type AgentWatchSession, type FirstPrompt } from './use-timeline-session'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import { assistantTimelineClient } from '@/components/assistant/assistantTimelineClient'
import { MOBILE_RESPONDER_ID } from './responder'

export type { AgentWatchPhase, AgentWatchSession } from './use-timeline-session'

/** 手机打开一台在线机器上的一条会话;同步逻辑见 use-timeline-session(与桌面会话页同一份)。 */
export function useAgentWatchSession(
  deviceId: string | null,
  sessionId: string | null,
  enabled: boolean,
  firstPrompt?: FirstPrompt,
  phoneHost = false,
  local = false,
  windowHistory = false,
): AgentWatchSession {
  return useTimelineSession(phoneHost ? phoneTimelineClient : windowHistory ? assistantTimelineClient(local, { window: true }) : local ? assistantTimelineClient(true) : sessionpageRpc, MOBILE_RESPONDER_ID, deviceId, sessionId, enabled, firstPrompt)
}
