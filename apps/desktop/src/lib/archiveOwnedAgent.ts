import { archiveIdentity } from '@gugu/core/cloud/agentIdentityRemoval'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ArchiveOutcome } from '@shared/core/sessions/sessions'
import { rpcOn } from '@renderer/lib/ipc'
import { confirmArchive } from '@renderer/features/sessions/archive-session-flow'
import { machineRpc } from '../components/session-watch/sessionpage-rpc'
import { invokePhoneHost } from '../mobile/local-agent/phoneHostRpc'
import { platform } from '../platform'
import { chatService } from './chat'
import { getCurrentAuthUserId, identityDb } from './supabase'
import { i18n } from '../i18n'

type SessionTarget = { projectId: string; sessionId: string }
type ArchiveTarget = { device: Device; session: SessionTarget } | null
export type AgentArchiveOptions = { removeSocialIdentity?: boolean }

function host(device: Device) {
  return device.is_current_device ? rpcOn(null) : platform.kind === 'electron' ? rpcOn(device.device_id) : machineRpc(device.device_id)
}

/** The device my agent's task runs on, read from the cloud alone (no call to that device). null = no task host. */
async function agentHostDevice(agentUserId: string): Promise<Device | null> {
  const owner = await getCurrentAuthUserId()
  const { data: agent, error } = await identityDb.from('users').select('id, device_id').eq('id', agentUserId).eq('owner_user_id', owner).eq('type', 'agent').single()
  if (error) throw error
  if (!agent.device_id) return null
  const { data: registered, error: deviceError } = await identityDb.from('gugu_devices').select('device_id').eq('user_id', owner).eq('device_id', agent.device_id).maybeSingle()
  if (deviceError) throw deviceError
  if (!registered) return null
  const device = (await chatService.listDevices({ includePhones: true, deviceIds: [agent.device_id] })).find((row) => row.device_id === agent.device_id)
  if (!device) throw new Error('The task host could not be resolved; reconnect and retry.')
  return device
}

async function sessionOnDevice(device: Device, agentUserId: string): Promise<SessionTarget | null> {
  return isPhoneDevice(device)
    ? await invokePhoneHost<SessionTarget | null>(device.device_id, 'sessionTimeline.sessionOfAgent', [agentUserId])
    : await host(device).sessionTimeline.sessionOfAgent(agentUserId)
}

/** Only an authoritative absent device/binding is "no task". Transport and directory failures propagate. */
export async function resolveAgentArchiveTarget(agentUserId: string): Promise<ArchiveTarget> {
  const device = await agentHostDevice(agentUserId)
  if (!device) return null
  const session = await sessionOnDevice(device, agentUserId)
  return session ? { device, session } : null
}

export async function archiveOwnedAgent(agentUserId: string, options: AgentArchiveOptions = {}): Promise<void> {
  if (options.removeSocialIdentity !== undefined && typeof options.removeSocialIdentity !== 'boolean') throw new Error('removeSocialIdentity must be a boolean')
  const removeSocialIdentity = options.removeSocialIdentity ?? true
  const target = await resolveAgentArchiveTarget(agentUserId)
  if (!target) {
    if (!removeSocialIdentity) throw new Error(i18n.t('confirmations.archiveAgentNoTask', { ns: 'contacts' }))
    await archiveIdentity(identityDb, agentUserId)
    return
  }
  const { device, session } = target
  const args = [session.projectId, session.sessionId, { withChildren: false, removeSocialIdentity }] as const
  const outcome = isPhoneDevice(device)
    ? await invokePhoneHost<ArchiveOutcome>(device.device_id, 'sessions.archiveSession', [...args])
    : await host(device).sessions.archiveSession(...args)
  if (outcome.unreached.length) throw new Error('The task host could not be reached; reconnect and retry.')
}

/**
 * The chat list, contacts and agent settings archive an agent through the one archive confirmation (archive-session-flow
 * `confirmArchive`); an orphan identity (no task left) can only be archived by removing it, so its option stays ticked.
 */
export async function confirmOwnedAgentArchive(agentUserId: string, name: string, archive: (id: string, options: AgentArchiveOptions) => Promise<void>): Promise<boolean> {
  const target = await resolveAgentArchiveTarget(agentUserId)
  const choice = await new Promise<boolean | null>((resolve) => confirmArchive({
    childCount: 0,
    description: i18n.t(target ? 'confirmations.archiveAgent' : 'confirmations.archiveAgentNoTask', { ns: 'contacts', name }),
    identity: target ? 'choice' : 'only',
    proceed: (_withChildren, removeSocialIdentity) => resolve(removeSocialIdentity),
    onCancel: () => resolve(null),
  }))
  if (choice === null) return false
  await archive(agentUserId, { removeSocialIdentity: choice })
  return true
}

/**
 * The one rename of my agent. Its name is its task's name (electron/.../sessions/task-name.ts). On the device that runs
 * its task, it is renamed there through `sessions.renameSession` — the rename the tab and the sidebar make — which writes
 * the roster, publishes the name and tells the running agent; returns that device. Anywhere else it returns null and the
 * caller writes the identity in the cloud: the device that runs the task adopts a cloud rename (owned-agent changes and at
 * start), so a rename works while that device is off. Chosen by where the task runs, ❌ by whether a call fails.
 */
export async function renameOwnedAgent(agentUserId: string, name: string): Promise<{ deviceId: string } | null> {
  const device = await agentHostDevice(agentUserId)
  if (!device?.is_current_device) return null
  const session = await sessionOnDevice(device, agentUserId)
  if (!session) return null
  if (isPhoneDevice(device)) await invokePhoneHost<void>(device.device_id, 'sessions.renameSession', [session.sessionId, name])
  else await host(device).sessions.renameSession(session.sessionId, name)
  return { deviceId: device.device_id }
}
