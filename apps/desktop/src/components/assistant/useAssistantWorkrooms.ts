import { useMemo } from 'react'
import { useOnChange } from '../../hooks/useOnChange'
import type { AssistantShellSnapshot } from '../../lib/assistantShellBridge'
import { assistantWorkrooms, type AssistantWorkrooms } from '../../lib/assistantChatList'
import { platform } from '../../platform'
import { useReplica } from '../../lib/replica'
import { useAuth } from '../../store/auth'
import { projectGroupBindings } from '../../session/renderer/features/projects/stores/project-group-bindings'
import { useDeviceSessions } from '../../session/shared/remote-sessions/session-directory'

/**
 * Which groups are the assistant's workrooms (❌ inferred from a group name). null = not read: no group hidden meanwhile.
 * Read from the assistant's home machine: its sessions as the session directory lists them live (this computer's
 * included; ❌ a second read of that list) and its project-group bindings (replica `projectGroupBindings`).
 */
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
  const reading = useReplica(projectGroupBindings, subject)
  // A membership change can change which bindings count: read again then (❌ on the first render).
  useOnChange(membershipKey, () => { if (subject) void projectGroupBindings.refresh(machine) })
  const bindings = reading.state === 'value' ? reading.value : null
  // Only a list read from that machine (❌ its heartbeat digest, `cached`): until then nothing is hidden.
  const listed = useDeviceSessions((live) => (deviceId ? live[deviceId] : undefined))
  const sessions = listed && !listed.cached ? listed.sessions : null
  return useMemo(() => (sessions && bindings && assistantId && ownerId ? assistantWorkrooms(assistantId, ownerId, sessions, bindings) : null), [sessions, bindings, assistantId, ownerId])
}
