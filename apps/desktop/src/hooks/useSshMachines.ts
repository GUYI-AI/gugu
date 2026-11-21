import { useCallback, useMemo } from 'react'
import { useReplica } from '../lib/replica'
import { SERVER_SSH_MACHINES_CHANNELS } from '../lib/serverSshMachines'
import { sshMachineAddresses, sshMachineIdsOf, watchSshMachineAddresses } from '../lib/sshMachineAddresses'
import { desktopIpc } from '../platform/desktopIpc'

/** `addresses` is null until read (a row then draws a placeholder for its route, ❌ a guessed one). */
export function useSshMachines(): {
  addresses: ReadonlyMap<string, string> | null
  forget: (deviceId: string) => Promise<void>
} {
  watchSshMachineAddresses()
  const reading = useReplica(sshMachineAddresses, [])
  const addresses = useMemo(() => (reading.state === 'value' ? new Map(reading.value) : null), [reading])

  const forget = useCallback(async (deviceId: string) => {
    const electron = desktopIpc()
    if (!electron) return
    await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.forget, deviceId)
  }, [])

  return { addresses, forget }
}

/** 这台电脑记着怎么 SSH 过去的远程 SSH 机器的设备 id;null = 还没读到(❌ 当成「一台都没有」)。 */
export function useSshMachineIds(): ReadonlySet<string> | null {
  watchSshMachineAddresses()
  const reading = useReplica(sshMachineAddresses, [])
  return reading.state === 'value' ? sshMachineIdsOf(reading.value) : null
}
