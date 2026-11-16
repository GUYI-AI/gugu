import { contactsService } from './contacts'
import { replica } from './replica'

/**
 * The groups I share with a contact (account replica, one reading per contact). A contact seen before shows its
 * groups on the first frame while they are read again; ❌「没有共同群」before the read answers (open-flicker CH21).
 * The rows are the server's; the names I gave groups are drawn over them where they are shown.
 */
export const commonGroupChats = replica({
  name: 'commonGroupChats',
  scope: 'account',
  read: (owner: string, contactId: string) => contactsService.getCommonGroupChats(owner, contactId),
})
