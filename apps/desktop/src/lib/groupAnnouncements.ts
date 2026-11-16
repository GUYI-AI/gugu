import type { GroupAnnouncement } from '@gugu/core/shared/types/chat'
import { chatService } from './chat'
import { readDisplayIdentities } from './identityReadAdapter'
import { openedImRepository } from './imRepository'
import { rendererLogger } from './log'
import { replica } from './replica'

const announcementLog = rendererLogger('chat/announcements')

/**
 * A group's announcements (account replica, one reading per group). An author may have left the group (no member
 * row, so no projection asks for their identity): the authors' identities are committed with each read. A failed
 * identity read is logged and the announcements still show — a missing name is loud where it is drawn (resolveOrLoud).
 */
export const groupAnnouncements = replica({
  name: 'groupAnnouncements',
  scope: 'account',
  read: async (owner: string, chatId: string): Promise<GroupAnnouncement[]> => {
    const rows = await chatService.getAnnouncements(chatId)
    // The rows show at once; the authors' identities follow them (a name missing meanwhile is loud where it is drawn).
    void openedImRepository(owner)
      .then(async (repository) => repository.putIdentities(await readDisplayIdentities(rows.map((row) => row.authorId))))
      .catch((err: unknown) => announcementLog.error({ chatId, err }, 'commit announcement author identities failed'))
    return rows
  },
})
