import { useEffect, useMemo, useRef } from 'react'
import type { AssistantShellSnapshot } from '../../lib/assistantShellBridge'
import { assistantWorkrooms, type AssistantWorkrooms } from '../../lib/assistantChatList'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { replica, useReplica } from '../../lib/replica'
import { useAuth } from '../../store/auth'
import { onMachineEvent, rpcOn } from '../../session/renderer/lib/ipc'
import { machineRpc } from '../session-watch/sessionpage-rpc'
import { projectGroupBindingChangedChannel } from '../../session/shared/core/projects/projectEvents'
import { sessionCreatedChannel } from '../../session/shared/core/sessions/sessionEvents'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

const log = rendererLogger('assistant/workrooms')

type WorkroomSources = { sessions: SessionpageSessionSummary[]; bindings: { projectId: string; chatId: string }[] }

/** The assistant's home host's session identities and project-group bindings (host push). `machine` null = this computer. */
export const assistantWorkroomSources = replica({
  name: 'assistantWorkroomSources',
  scope: 'account',
  networkMode: platform.capabilities.agentRuntime ? 'always' : 'online',
  read: async (_owner: string, machine: string | null): Promise<WorkroomSources> => {
    const rpc = platform.capabilities.agentRuntime ? rpcOn(machine) : machineRpc(machine!)
    const [listed, bound] = await Promise.all([rpc.sessionTimeline.sessionsList(), rpc.projects.listProjectGroupBindings()])
    if (!bound.success) {
      log.warn({ error: JSON.stringify(bound.error) }, 'could not read assistant workroom ownership')
      throw new Error(JSON.stringify(bound.error))
    }
    return { sessions: listed.sessions, bindings: bound.data }
  },
  fresh: platform.capabilities.agentRuntime ? Infinity : 0,
  watch: {
    group: (machine) => machine,
    start: (_owner, machine) => {
      if (!platform.capabilities.agentRuntime) return () => undefined
      const refresh = () => { void assistantWorkroomSources.refresh(machine) }
      const offBindings = onMachineEvent(machine, projectGroupBindingChangedChannel, refresh)
      const offSessions = onMachineEvent(machine, sessionCreatedChannel, refresh)
      return () => { offBindings(); offSessions() }
    },
  },
})

/** Which groups are the assistant's workrooms (❌ inferred from a group name). null = not read: no group hidden meanwhile. */
export function useAssistantWorkrooms(shell: AssistantShellSnapshot | null, membershipKey: string): AssistantWorkrooms | null {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const assistantId = shell?.assistantState === 'found' ? shell.assistant?.id ?? null : null
  const home = shell?.home
  const deviceId = home?.deviceId ?? null
  const local = home?.kind === 'computer' && home.thisDevice
  // 推送在助理所在的那台机器上订(本机 = null);手机经那台机器的管道读它,只读不订。
  const machine = local && platform.capabilities.agentRuntime ? null : deviceId
  const subject = ownerId && assistantId && deviceId ? [machine] as [string | null] : null
  const reading = useReplica(assistantWorkroomSources, subject)
  // A membership change can change which bindings count: read again then (❌ on the first render).
  const lastMembership = useRef(membershipKey)
  useEffect(() => {
    if (lastMembership.current === membershipKey) return
    lastMembership.current = membershipKey
    if (subject) void assistantWorkroomSources.refresh(machine)
  }, [membershipKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const sources = reading.state === 'value' ? reading.value : null
  return useMemo(() => (sources && assistantId && ownerId ? assistantWorkrooms(assistantId, ownerId, sources.sessions, sources.bindings) : null), [sources, assistantId, ownerId])
}
