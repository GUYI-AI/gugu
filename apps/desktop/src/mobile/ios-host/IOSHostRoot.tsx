import { useEffect } from 'react'
import { iosHostRuntime } from './iosHostRuntime'
import { iosPlatform } from '@/platform/ios'
import { getIOSOwnerPublicationSnapshot, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import { startIOSHostDirectory } from './iosHostDirectory'
import type { IOSHostRuntimeStore } from './iosHostRuntimeStore'

/** A mounts this independently of Android PhoneDeviceRoot and capability flags. */
export function IOSHostRoot({ runtime = iosHostRuntime }: { runtime?: Pick<IOSHostRuntimeStore, 'start' | 'getSnapshot' | 'subscribe'> }) {
  useEffect(() => {
    const stopRuntime = runtime.start()
    const stopDirectory = startIOSHostDirectory(runtime, { getSnapshot: getIOSOwnerPublicationSnapshot, subscribe: subscribeIOSOwnerPublication }, () => iosPlatform.capabilities.phoneAgentHost === true)
    return () => { stopDirectory(); stopRuntime() }
  }, [runtime])
  return null
}
