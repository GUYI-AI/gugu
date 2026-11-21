import { replica } from './replica'
import { SERVER_SSH_MACHINES_CHANNELS, type SshMachineSummary } from './serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'

/** 这台桌面上用 SSH 装上的机器(设备 id → 地址;跟账号走),唯一的一读。主进程推 `changed`,故 `fresh: Infinity`;没有桌面主进程 ⇒ 空。 */
export const sshMachineAddresses = replica({
  name: 'sshMachineAddresses',
  scope: 'account',
  networkMode: 'always',
  read: async (): Promise<Array<[string, string]>> => {
    const electron = desktopIpc()
    if (!electron) return []
    const value: unknown = await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.describe)
    if (!Array.isArray(value)) throw new Error('SSH machines: unexpected answer')
    return (value as SshMachineSummary[])
      .filter((item) => item && typeof item.deviceId === 'string' && typeof item.display === 'string')
      .map((item) => [item.deviceId, item.display])
  },
  fresh: Infinity,
  // A failed read is read again when the window comes back; ❌ retried: its callers fail loud at once.
  refreshOnFocus: true,
  persist: { maxBytes: 8192, maxEntries: 1 },
})
let watching = false
/** Main says when the list changes (listened to once per document). */
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
