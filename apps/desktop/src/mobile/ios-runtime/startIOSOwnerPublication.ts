import { sessionCoordinator } from '@/lib/sessionCoordinator'
import { platform } from '@/platform'
import { iosOwnerClient } from './iosOwnerClient'
import { IOSOwnerPublication } from './iosOwnerPublication'

// One App-root instance preserves the retirement barrier across effect restarts.
const publication = new IOSOwnerPublication(sessionCoordinator, iosOwnerClient,
  (changed, failed) => platform.subscribeAppForeground(changed, failed))

export const getIOSOwnerPublicationSnapshot = publication.getSnapshot
export const subscribeIOSOwnerPublication = publication.subscribe
export const retryIOSOwnerPublication = (): Promise<void> => {
  // A failed stop can leave the projection inactive. Explicit retry reopens only
  // its subscriptions; the coordinator and native retirement fence keep ownership.
  publication.start()
  return publication.refresh()
}
export const stopIOSOwnerPublication = () => publication.stop()

/** A mounts this once at the App root; auth coordinator ownership stays unchanged. */
export function startIOSOwnerPublication(): () => void {
  publication.start()
  return () => {
    // React cleanup cannot await; failure stays visible in the publication store.
    void publication.stop().catch(() => undefined)
  }
}
