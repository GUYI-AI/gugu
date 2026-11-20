import { requestConversationDeleteConfirmation } from './conversationDeleteConfirmation'
import { currentAuthSessionSignal } from './authSessionLoss'

/** Shared by desktop right-click and phone long-press menus. */
export async function confirmDeleteConversation({ name = '', clear }: { name?: string; clear: () => Promise<void> }): Promise<void> {
  const boundary = currentAuthSessionSignal()
  const confirmed = await requestConversationDeleteConfirmation(boundary, name)
  if (confirmed && !boundary.aborted) await clear()
}
