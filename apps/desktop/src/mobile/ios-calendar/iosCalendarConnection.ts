import { replica } from '@/lib/replica'
import { iosCalendarPermissions, type IOSCalendarSnapshot } from './iosCalendarPermissions'

/**
 * This phone's calendar for the account (native owner binding). Signal tier: the panel drops the shown value and reads again
 * on foreground, so a revoked grant is never shown as connected. ❌ Persisted (only what native answered in this run).
 */
export const iosCalendarConnection = replica({
  name: 'iosCalendarConnection',
  scope: 'account',
  read: (owner: string): Promise<IOSCalendarSnapshot> => iosCalendarPermissions.read(owner),
})
