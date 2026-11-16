import { replica } from '@/lib/replica'
import { iosCalendarPermissions, type IOSCalendarPermissionClient, type IOSCalendarSnapshot } from './iosCalendarPermissions'

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
 * connected while it is checked. ❌ Kept across restarts: the panel shows and changes only what native answered in this
 * run (a grant revoked in Settings while the App was closed is never drawn as connected, its binding never used).
 */
export const iosCalendarConnection = replica({
  name: 'iosCalendarConnection',
  scope: 'account',
  read: (owner: string): Promise<IOSCalendarSnapshot> => client.read(owner),
  fresh: 0,
})
