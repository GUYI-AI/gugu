import { queryClient, replica } from '@/lib/replica'
import { iosCalendarPermissions, type IOSCalendarPermissionClient, type IOSCalendarSnapshot } from './iosCalendarPermissions'

/** The native calendar client the replica and the connection commands use; a test sets its own (`setIOSCalendarClientForTesting`). */
let client: IOSCalendarPermissionClient = iosCalendarPermissions

/** Test seam: the native client behind the replica and the commands (undefined = the real one). */
export function setIOSCalendarClientForTesting(next?: IOSCalendarPermissionClient): void {
  client = next ?? iosCalendarPermissions
}

export function iosCalendarClient(): IOSCalendarPermissionClient {
  return client
}

/**
 * This phone's calendar for the signed-in account (native owner binding): the OS authorization and whether the
 * calendar category is connected for this owner. Account scope (the owner is the account). Read on open; a command
 * (connect / disconnect) puts the snapshot it answered. An environment fact (signal tier): the panel reads it again
 * when the App comes back to the foreground, dropping the shown value first so a revoked grant is never shown as
 * connected while it is checked. Kept across restarts: bounded (three ids, a revision, a few flags).
 */
export const iosCalendarConnection = replica({
  name: 'iosCalendarConnection',
  scope: 'account',
  read: (owner: string): Promise<IOSCalendarSnapshot> => client.read(owner),
  fresh: 0,
  persist: { maxBytes: 512, maxEntries: 1 },
})

/** Read again from scratch: what was shown is dropped (unknown) until the native answer lands; a read on its way is replaced. */
export function recheckIOSCalendarConnection(): Promise<void> {
  const key = iosCalendarConnection.key()
  return key ? queryClient.resetQueries({ queryKey: key, exact: true }) : Promise.resolve()
}
