import { useEffect } from 'react'
import { iosHostRuntime } from './iosHostRuntime'
import type { IOSHostRuntimeStore } from './iosHostRuntimeStore'

/** A mounts this independently of Android PhoneDeviceRoot and capability flags. */
export function IOSHostRoot({ runtime = iosHostRuntime }: { runtime?: Pick<IOSHostRuntimeStore, 'start'> }) {
  useEffect(() => runtime.start(), [runtime])
  return null
}
