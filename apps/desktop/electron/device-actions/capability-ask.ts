/**
 * An agent calls an action of a group this computer has not connected: instead of telling it to send the person to Settings,
 * the person is asked right there — an approval in the agent's own session (Ask source `device-capability`), the same chain an
 * App install asks through, so the session page, the chat's band, the phone and the notification list all show it and the
 * first answer settles it. 「允许」 connects the group the way Settings → Devices does (macOS permission included) and the call
 * goes on; anything else leaves it unconnected and says why.
 */
import { randomUUID } from 'node:crypto'
import type { DeviceActionErrorCode } from '@gugu/core/shared/deviceActions'
import {
  DEVICE_CAPABILITY_ALLOW,
  DEVICE_CAPABILITY_DECLINE,
  type DeviceCapabilityAsk,
} from '../../src/session/shared/device-capability-ask'
import type { DeviceActionsRuntime } from './runtime'

type Ask = typeof import('../session/main/core/asks').ask

export interface CapabilityAskInput {
  /** The calling agent's session (where the approval is shown). */
  sessionId: string
  action: string
  requester: DeviceCapabilityAsk['requester']
  runtime: Pick<DeviceActionsRuntime, 'ungrantedGroup' | 'connect'>
  /** The call going away withdraws the ask. */
  signal?: AbortSignal
  ask?: Ask
}

/** Null: go on with the call (connected now, or nothing to ask — the device answers for itself). Otherwise why it stops here. */
export async function askForCapability(input: CapabilityAskInput): Promise<{ code: DeviceActionErrorCode; message: string } | null> {
  const missing = input.runtime.ungrantedGroup(input.action)
  if (!missing) return null
  const name = missing.groupTitle['en-US']
  const payload: DeviceCapabilityAsk = { group: missing.group, groupTitle: missing.groupTitle, action: input.action, requester: input.requester }
  const ask = input.ask ?? (await import('../session/main/core/asks')).ask
  const answer = await ask(input.sessionId, {
    itemId: randomUUID(),
    kind: 'permission',
    // What a surface that does not know this source shows; those that do word it in their own language.
    title: `${input.requester.name} wants to use "${name}" on this computer`,
    options: [
      { optionId: DEVICE_CAPABILITY_ALLOW, name: 'Allow', kind: 'allow_always' },
      { optionId: DEVICE_CAPABILITY_DECLINE, name: "Don't allow", kind: 'reject_once' },
    ],
    origin: { source: 'device-capability', payload },
  }, { ...(input.signal ? { signal: input.signal } : {}) })
  // Not a session of this computer: nothing to ask in; the device's own not_granted says where to connect it.
  if (answer === 'unavailable') return null
  if (answer === 'timeout') return { code: 'not_granted', message: `Nobody answered the request to use "${name}" on this computer in time; it stays unconnected. Ask again when the person is around.` }
  if (answer === 'withdrawn') return { code: 'execution_failed', message: `The request to use "${name}" was withdrawn before it was answered (the call went away).` }
  if (answer.optionId !== DEVICE_CAPABILITY_ALLOW) return { code: 'not_granted', message: `The person declined "${name}" on this computer. Do not ask again unless they bring it up.` }
  const connected = await input.runtime.connect(missing.group)
  if (connected.ok) return null
  return { code: connected.code === 'os_permission' ? 'os_permission' : 'execution_failed', message: `The person allowed "${name}", but connecting it failed: ${connected.message}` }
}
