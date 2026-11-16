import { replica, type Reading } from './replica'
import { SERVER_SSH_MACHINES_CHANNELS, type SshMachineSummary } from './serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'
import { rendererLogger } from './log'

const registryLog = rendererLogger('ssh-registry')

/**
 * 这台桌面上用 SSH 装上的机器(设备 id → 给人看的地址),见 electron/server/ssh-machines.ts。主进程按登录账号筛,
 * 所以跟账号走。这是这份清单唯一的一读:设备 RPC 挑通道(lib/sshLinkChannel.ts)、侧栏、设置 → 设备都读它。
 * 推送:主进程装上 / 忘掉一台时发 `changed`,主进程接受了一份登录镜像(启动恢复、续期)以后渲染层再读一次
 * (`refreshSshMachines`),所以值一直是最新的(`fresh: Infinity`)。没有桌面主进程(网页、手机)⇒ 空:那里没有 SSH 这条路。
 */
export const sshMachineAddresses = replica({
  name: 'sshMachineAddresses',
  scope: 'account',
  networkMode: 'always',
  read: async (): Promise<Array<[string, string]>> => {
    const electron = desktopIpc()
    if (!electron) return []
    let value: unknown
    try {
      value = await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.describe)
      if (!Array.isArray(value)) throw new Error('SSH machines: unexpected answer')
    } catch (error) {
      registryLog.warn({ error: error instanceof Error ? error.message : String(error) }, 'SSH machine registry read failed; the next request reads again')
      throw error
    }
    return (value as SshMachineSummary[])
      .filter((item) => item && typeof item.deviceId === 'string' && typeof item.display === 'string')
      .map((item) => [item.deviceId, item.display])
  },
  fresh: Infinity,
  // A failed read is not for ever (until then every SSH machine is drawn by its cloud heartbeat): read again when the
  // window comes back (a value is kept; only a reading without one is stale). ❌ retried: its callers fail loud at once.
  refreshOnFocus: true,
  persist: { maxBytes: 8192, maxEntries: 1 },
})
let watching = false
/** Main says when the list changes: listened to from the first reader on (once per document). */
export function watchSshMachineAddresses(): void {
  if (watching) return
  const electron = desktopIpc()
  if (!electron) return
  watching = true
  electron.eventOn(SERVER_SSH_MACHINES_CHANNELS.changed, () => { void sshMachineAddresses.refresh() })
}

const idsOf = new WeakMap<Array<[string, string]>, ReadonlySet<string>>()

/** The machine ids of a reading's value (one Set per value, a stable reference). */
export function sshMachineIdsOf(value: Array<[string, string]>): ReadonlySet<string> {
  let ids = idsOf.get(value)
  if (!ids) idsOf.set(value, ids = new Set(value.map(([id]) => id)))
  return ids
}

/** For code outside React (the device RPC's transport choice): told whenever the list's entry changes. */
export function subscribeSshMachineAddresses(listener: () => void): () => void {
  return sshMachineAddresses.subscribe([], listener)
}

export type SshMachineAddressesReading = Reading<Array<[string, string]>>
