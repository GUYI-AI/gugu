import type { PublicGroupInviteLookupResult } from '@gugu/core/shared/types/contacts'
import { contactsService } from './contacts'
import { replica } from './replica'

/**
 * A public group as its invite number shows it to this account (found or not, a member already or not). No push: read on
 * open (`fresh: 0`), kept five minutes; a join puts the group it answered. A failed lookup is an error reading.
 */
export const publicGroupInvite = replica({
  name: 'publicGroupInvite',
  scope: 'account',
  read: (_owner: string, publicId: number): Promise<PublicGroupInviteLookupResult> => contactsService.lookupPublicGroupInvite(publicId),
  fresh: 0,
  keep: 5 * 60_000,
})
