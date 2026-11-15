import { useCallback, useEffect } from 'react'
import { DEVICE_ACTIONS_CHANNELS, type DeviceActionsState } from '../lib/deviceActionsIpc'
import { rendererLogger } from '../lib/log'
import { replica, useReplica } from '../lib/replica'
import { messageForUser } from '../lib/userFacingError'
import { desktopIpc } from '../platform/desktopIpc'

const log = rendererLogger('device-actions')

/**
 * 这台电脑「能做的事」此刻的样子(主进程现读,device)。主进程变了就推 `changed`:推送喂的,`fresh: Infinity`。
 * 只在桌面上有;不持久化(设置页,不是首屏)。
 */
const thisDeviceActions = replica({
  name: 'thisDeviceActions',
  scope: 'device',
  read: async (): Promise<DeviceActionsState> => {
    const ipc = desktopIpc()
    if (!ipc) throw new Error('This device has no device actions')
    try {
      return await ipc.invoke(DEVICE_ACTIONS_CHANNELS.state) as DeviceActionsState
    } catch (error) {
      log.error({ error: String(error) }, 'this device actions state read failed')
      throw error
    }
  },
  fresh: Infinity,
})
// Pushed by main while any surface shows it (one watch, reference counted).
let watchers = 0
let stopWatch: (() => void) | undefined
function watchChanges(): () => void {
  if (watchers++ === 0) stopWatch = desktopIpc()?.eventOn(DEVICE_ACTIONS_CHANNELS.changed, () => { void thisDeviceActions.refresh() })
  return () => { if (--watchers === 0) { stopWatch?.(); stopWatch = undefined } }
}

/** 这台电脑「能做的事」;不是桌面 = 一直 null。助理 App「能力 · 设备」那一行也读它。读取失败 ❌ 一直停在「读取中」。 */
export function useThisDeviceState(): { state: DeviceActionsState | null; readError: string | null; reload: () => void } {
  const desktop = desktopIpc() !== null
  const reading = useReplica(thisDeviceActions, desktop ? [] : null)
  useEffect(() => (desktop ? watchChanges() : undefined), [desktop])
  const reload = useCallback(() => { void thisDeviceActions.refresh() }, [])
  return {
    state: reading.state === 'value' ? reading.value : null,
    readError: reading.state === 'error' ? messageForUser(reading.error) : reading.state === 'value' && reading.error ? messageForUser(reading.error) : null,
    reload,
  }
}
