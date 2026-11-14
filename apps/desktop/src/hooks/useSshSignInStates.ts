import { useMemo } from 'react'
import { readModel, useReadModels, type Reading } from '../lib/readModel'
import type { Device } from '@gugu/core/shared/types/chat'
import { SERVER_SSH_MACHINES_CHANNELS, type SshSignInState } from '../lib/serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'

/**
 * #6264 哪几台要问「这个账号在那台机器上还登着吗」:离线的、这台桌面记着怎么 SSH 过去的。
 * 每台一个键(设备 id + 上次在线时间):同一段离线只问一次,它回来又走了才再问。纯函数,单测钉住。
 */
export function signInProbeKeys(devices: readonly Device[], sshAddress: (deviceId: string) => string | null | undefined): Map<string, string> {
  const keys = new Map<string, string>()
  for (const device of devices) {
    if (device.is_online || device.is_current_device || !sshAddress(device.device_id)) continue
    keys.set(device.device_id, `${device.device_id}@${device.last_seen_at ?? ''}`)
  }
  return keys
}

/**
 * 离线的 SSH 机器各问一次(经 SSH 读那台机器的 `gugu-server status --json`),答案决定设备行上写「离线」
 * 还是「登录已失效 · 重新登录」。触发:打开「设置 → 设备」、或某台刚变成离线;❌ 轮询。
 * 每问一次 = 一次 ssh(复用终端的连接时几十毫秒;连不上 8 秒超时)。
 */
/** The answer for one offline machine; keyed by its last-online time, so one stretch offline is asked once. Not kept across restarts: an old answer is the wrong answer. */
const sshSignInState = readModel({
  name: 'sshSignInState',
  scope: 'account',
  read: async (_userId, deviceId: string, _offlineSince: string) => {
    const electron = desktopIpc()
    if (!electron) throw new Error('SSH sign-in state needs the desktop host')
    return ((await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.signInState, deviceId)) ?? { state: 'unknown' }) as SshSignInState
  },
  fresh: Infinity,
})

/** Every offline SSH machine's reading; a machine missing from the map needs no answer (online, or not reached over SSH). */
export function useSshSignInStates(
  devices: readonly Device[],
  sshAddress: (deviceId: string) => string | null | undefined,
): ReadonlyMap<string, Reading<SshSignInState>> {
  const keys = useMemo(() => [...signInProbeKeys(devices, sshAddress)], [devices, sshAddress])
  const readings = useReadModels(sshSignInState, keys.map(([deviceId, key]) => [deviceId, key] as [string, string]))
  return useMemo(() => new Map(keys.map(([deviceId], index) => [deviceId, readings[index]])), [keys, readings])
}
