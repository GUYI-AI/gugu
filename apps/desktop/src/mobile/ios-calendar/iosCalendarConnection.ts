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
 * This phone's calendar for the account (native owner binding). Signal tier: the panel drops the shown value and reads again
 * on foreground, so a revoked grant is never shown as connected. ❌ Persisted (only what native answered in this run).
 */
export const iosCalendarConnection = replica({
  name: 'iosCalendarConnection',
  scope: 'account',
  read: (owner: string): Promise<IOSCalendarSnapshot> => client.read(owner),
  fresh: 0,
})
