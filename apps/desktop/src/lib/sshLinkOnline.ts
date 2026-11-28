// #6264 远程 SSH 的机器,在添加它的这台电脑上:这台电脑与它之间走 SSH(设备连接),所以在线与否也看这条连接。
// 别的电脑与手机上它照常列出、经咕咕云使用,在线读心跳(owner 2026-10-08 选 B,product spec)。
import { serverProtocolTooOld } from '@gugu/core/cloud/serverMachineHealth'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SshLinkFailure, SshLinkState } from './sshLink'

// An update already observed on the host takes precedence over a pending local protocol probe.
// Authentication, transport errors and explicit attempt failures keep their own cause.
export function reportedSshUpdate(device: Pick<Device, 'status' | 'capabilities'>, problem: SshLinkFailure | null): SshLinkFailure | null {
  // status is the cloud observation; the device list also marks retryable SSH hosts is_online.
  if (!isDeviceOnline(device.status) || (problem !== 'outdated' && problem !== 'waitingIdle' && problem !== 'confirmationRequired' && problem !== 'updating')) return problem
  const caps = device.capabilities
  const update = caps?.server_update
  if (update && update.version !== caps.app_version) {
    if (update.state === 'ready') return 'waitingIdle'
    if (update.state === 'downloading' || update.state === 'switching') return 'updating'
    if (update.state === 'failed') return 'updateFailed'
  }
  const outcome = caps?.server_update_outcome ?? update?.lastOutcome
  if (outcome?.kind === 'switched' && typeof caps.remote_protocol === 'number' && !serverProtocolTooOld(caps.remote_protocol)) return null
  return problem
}

/** isOnline is the existing routing input, including hosts that should still be retried.
 * sshLink carries the observation shown to the user, independently of that retry policy.
 */
export function sshLinkFacts(
  isSshMachine: boolean,
  problem: SshLinkFailure | null,
  cloudOnline: boolean,
): { isOnline: boolean; sshLink?: SshLinkState | null } {
  if (!isSshMachine) return { isOnline: cloudOnline }
  const needsUser = problem === 'disconnected' || problem === 'signInRequired' || problem === 'hostKeyChanged' || problem === 'notSignedIn'
  return { isOnline: !needsUser, sshLink: problem }
}

/** A machine's link facts while the SSH list may be unread (`sshMachines` null): `linkUnknown`, ❌ the cloud's offline. */
export function remoteLinkFacts(
  deviceId: string,
  sshMachines: ReadonlySet<string> | null,
  problem: SshLinkFailure | null,
  cloudOnline: boolean,
): { isOnline: boolean; sshLink?: SshLinkState | null; linkUnknown?: true } {
  if (sshMachines === null) return { isOnline: cloudOnline, linkUnknown: true }
  return sshLinkFacts(sshMachines.has(deviceId), problem, cloudOnline)
}

/** 设备列表里远程 SSH 的那几行:在线与否换成设备连接的读数(所有读 useDevicesStore 的面同一个说法)。 */
export function withSshLinkOnline<T extends Pick<Device, 'device_id' | 'is_online'>>(
  devices: readonly T[],
  sshMachineIds: ReadonlySet<string>,
  problems: ReadonlyMap<string, SshLinkFailure | null>,
): T[] {
  return devices.map((device) => {
    if (!sshMachineIds.has(device.device_id)) return device
    const online = sshLinkFacts(true, problems.get(device.device_id) ?? null, device.is_online).isOnline
    return online === device.is_online ? device : { ...device, is_online: online }
  })
}
