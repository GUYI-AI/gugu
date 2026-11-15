import { useCallback, useMemo } from 'react'
import { readModel, useReadModel } from '../lib/readModel'
import { SERVER_SSH_MACHINES_CHANNELS, type SshMachineSummary } from '../lib/serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'

/**
 * 这台桌面上用 SSH 装上的机器(设备 id → 给人看的地址),见 electron/server/ssh-machines.ts。主进程按登录账号筛,
 * 所以跟账号走;装上 / 忘掉一台时重读。没有桌面主进程(网页、手机)⇒ 空:那里没有 SSH 这条路。
 */
const sshMachineAddresses = readModel({
  name: 'sshMachineAddresses',
  scope: 'account',
  read: async (): Promise<Array<[string, string]>> => {
    const electron = desktopIpc()
    if (!electron) return []
    const value: unknown = await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.describe)
    if (!Array.isArray(value)) throw new Error('SSH machines: unexpected answer')
    return (value as SshMachineSummary[])
      .filter((item) => item && typeof item.deviceId === 'string' && typeof item.display === 'string')
      .map((item) => [item.deviceId, item.display])
  },
  persist: true,
})
desktopIpc()?.eventOn(SERVER_SSH_MACHINES_CHANNELS.changed, () => { void sshMachineAddresses.refresh() })

/** `addresses` is null until read (a row then draws a placeholder for its route, ❌ a guessed one). */
export function useSshMachines(): {
  addresses: ReadonlyMap<string, string> | null
  forget: (deviceId: string) => Promise<void>
} {
  const reading = useReadModel(sshMachineAddresses, [])
  const addresses = useMemo(() => (reading.state === 'value' ? new Map(reading.value) : null), [reading])

  const forget = useCallback(async (deviceId: string) => {
    const electron = desktopIpc()
    if (!electron) return
    await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.forget, deviceId)
  }, [])

  return { addresses, forget }
}
