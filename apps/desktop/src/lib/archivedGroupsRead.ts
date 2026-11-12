// #2548 The groups this account's chat list has read as archived (a dissolved group: its status is archived). The chat
// list drops such a group's conversation the moment it reads that status; whatever lists the group from another source
// asks here, so it does not show the group as a row that is merely not a conversation yet. The one list's project rows
// come from the account project list, which reads the dissolve on its own a moment later (or never, if that read fails).
//
// Only read facts are written: the chat projection's read of the group's row (status archived, or no longer), and the
// group admin's answer to this account archiving it (deleteListedConversation). One per account: the projection clears it
// when it is reset for another account.

let read: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function replace(next: ReadonlySet<string>): void {
  read = next
  for (const listener of listeners) listener()
}

/** The chat list read this group's status: archived or not. Notifies only on a change. */
export function noteGroupArchived(chatId: string, archived: boolean): void {
  if (read.has(chatId) === archived) return
  const next = new Set(read)
  if (archived) next.add(chatId)
  else next.delete(chatId)
  replace(next)
}

/** Another account, or none: nothing read for the previous one applies. */
export function forgetArchivedGroups(): void {
  if (read.size > 0) replace(new Set())
}

export function readArchivedGroups(): ReadonlySet<string> {
  return read
}

export function subscribeArchivedGroups(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
