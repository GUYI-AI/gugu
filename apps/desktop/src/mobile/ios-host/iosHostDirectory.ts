import type { DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { removeDeviceSessions, updateDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { sameIOSBinding } from './iosAgentClient'
import type { IOSHostOwnerSource, IOSHostRuntimeSnapshot } from './iosHostRuntimeStore'

type Runtime = { getSnapshot(): IOSHostRuntimeSnapshot; subscribe(changed: () => void): () => void }
type Directory = { publish(deviceId: string, value: DeviceSessions): void; remove(deviceId: string): void }
const sharedDirectory: Directory = { publish: updateDeviceSessions, remove: removeDeviceSessions }

/** Use the App's one verified native observation. No second host, poller or auth owner. */
export function startIOSHostDirectory(runtime: Runtime, owner: IOSHostOwnerSource, available: () => boolean, directory: Directory = sharedDirectory): () => void {
  let published: string | null = null
  let stopped = false
  const withdraw = () => { if (published) { const id = published; published = null; directory.remove(id) } }
  const synchronize = () => {
    if (stopped) return
    const publication = owner.getSnapshot(), state = runtime.getSnapshot(), binding = state.binding, host = state.host
    if (!available() || publication.status !== 'ready' || !binding || !sameIOSBinding(publication.binding, binding)
      || state.phase !== 'configured' || !host || host.ownerId !== binding.ownerId || host.deviceId !== binding.deviceId
      || binding.deviceId !== `phone-${binding.installationId}-${binding.ownerId}` || !host.project) { withdraw(); return }
    if (published && published !== binding.deviceId) withdraw()
    const sessions = host.sessions.map((agent): SessionpageSessionSummary => ({
      conversationId: agent.sessionId, projectId: host.project!.id, title: agent.displayName,
      harness: 'pi', runtime: 'acp', agentStatus: agent.status,
      status: { status: agent.status, detail: agent.status === 'working' ? 'running' : agent.status === 'needs_user' ? 'question' : null },
      lastInteractedAt: agent.lastActiveAt ?? null, supported: host.taskTimeline,
      recordState: host.taskTimeline ? undefined : 'harness-unsupported', agent: { userId: agent.agentUserId }, chatId: agent.chatId,
    }))
    published = binding.deviceId
    directory.publish(binding.deviceId, { projects: [host.project], sessions, cached: !host.ready,
      connected: host.ready, hostOnline: host.ready, loading: host.status === 'starting', error: host.error })
  }
  const detachRuntime = runtime.subscribe(synchronize), detachOwner = owner.subscribe(synchronize)
  synchronize()
  return () => { stopped = true; detachOwner(); detachRuntime(); withdraw() }
}
