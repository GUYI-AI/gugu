import { useSyncExternalStore } from 'react'
import { getIOSOwnerPublicationSnapshot, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import { iosAgentClient } from './iosAgentClient'
import { IOSHostRuntimeStore } from './iosHostRuntimeStore'

// A mounts the existing owner publication first. This never starts auth/refresh.
// One App-root store retains configuration custody across subscription remounts.
export const iosHostRuntime = new IOSHostRuntimeStore({
  getSnapshot: getIOSOwnerPublicationSnapshot,
  subscribe: subscribeIOSOwnerPublication,
}, iosAgentClient)

export function useIOSHostRuntimeSnapshot(runtime: IOSHostRuntimeStore = iosHostRuntime) {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
}
