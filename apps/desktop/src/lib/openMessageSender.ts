import type { MessageSenderTarget } from '@gugu/session-chat-ui'
import { followLink, openLinkTarget, type SenderFile } from './guguLinks'
import { notify } from './notices'

/** A path in a message is on its sender's machine: it opens in that agent's task, where the path means something. */
export function openSenderFile(userId: string, sourceChatId: string | undefined, file: SenderFile): void {
  void openLinkTarget({ kind: 'sender', userId, ...(sourceChatId ? { sourceChatId } : {}), file }).catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
}

/** The existing shell opens groups/messages, sessions and private peers. */
export function openMessageSender(target: MessageSenderTarget): void {
  if (target.kind !== 'sender') { followLink(target); return }
  void openLinkTarget(target).catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
}
