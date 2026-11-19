import { replicaAccount } from './replica'
import { rendererLogger } from './log'

type RemovalFacts = { accountId: string; isRemoved: (chatId: string) => boolean; readRestored?: (chatIds: readonly string[]) => Promise<void> }
type ExplicitRemoval = { accountId: string; chatId: string }
const KEY = '__GUGU_CHAT_REMOVAL_FACTS__'
const EVENT = 'gugu:chat-removal-facts'
const state = () => window as unknown as Record<string, RemovalFacts | undefined>

/** The existing projection's deletion/membership facts, never display-list absence. */
export function publishChatRemovalFacts(accountId: string, isRemoved: RemovalFacts['isRemoved'], readRestored?: RemovalFacts['readRestored']): void {
  state()[KEY] = { accountId, isRemoved, readRestored }
  window.dispatchEvent(new Event(EVENT))
}

/** A confirmed local delete/leave is also an authoritative fact. */
export function publishChatRemoved(accountId: string, chatId: string): void {
  window.dispatchEvent(new CustomEvent<ExplicitRemoval>(EVENT, { detail: { accountId, chatId } }))
}

export function clearChatRemovalFacts(): void { delete state()[KEY] }

/** Screen and parked groups supply their own ids; no second list or tombstone cache. */
export function subscribeChatRemovals(candidates: () => readonly string[], remove: (chatId: string) => void, restored: () => readonly string[] = candidates): () => void {
  const check = (event?: Event) => {
    const explicit = (event as CustomEvent<ExplicitRemoval> | undefined)?.detail
    const accountId = replicaAccount().id
    if (explicit) {
      if (explicit.accountId === accountId) remove(explicit.chatId)
      return
    }
    const facts = state()[KEY]
    if (!facts || facts.accountId !== accountId) return
    for (const id of candidates()) if (facts.isRemoved(id)) remove(id)
    void facts.readRestored?.(restored()).catch(error => rendererLogger('chat/layout-removal').error({ error, accountId }, 'restored layout membership read failed; layout retained'))
  }
  window.addEventListener(EVENT, check)
  check()
  return () => window.removeEventListener(EVENT, check)
}
