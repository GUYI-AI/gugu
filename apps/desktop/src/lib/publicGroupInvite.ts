import type { PublicGroupInviteLookupResult } from '@gugu/core/shared/types/contacts'
import { contactsService } from './contacts'
import { replica } from './replica'

/** A public group as its invite number shows it to this account; read on open, a join puts what it answered. */
export const publicGroupInvite = replica({
  name: 'publicGroupInvite',
  scope: 'account',
  read: (_owner: string, publicId: number): Promise<PublicGroupInviteLookupResult> => contactsService.lookupPublicGroupInvite(publicId),
  fresh: 0,
  keep: 5 * 60_000,
})
