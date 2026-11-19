import { replicaAccount } from './replica'

type RemovalFacts = { accountId: string; isRemoved: (chatId: string) => boolean }
type ExplicitRemoval = { accountId: string; chatId: string }
const KEY = '__GUGU_CHAT_REMOVAL_FACTS__'
const EVENT = 'gugu:chat-removal-facts'
const state = () => window as unknown as Record<string, RemovalFacts | undefined>

/** The existing projection's deletion/membership facts, never display-list absence. */
export function publishChatRemovalFacts(accountId: string, isRemoved: RemovalFacts['isRemoved']): void {
  state()[KEY] = { accountId, isRemoved }
  window.dispatchEvent(new Event(EVENT))
}

/** A confirmed local delete/leave is also an authoritative fact. */
export function publishChatRemoved(accountId: string, chatId: string): void {
  window.dispatchEvent(new CustomEvent<ExplicitRemoval>(EVENT, { detail: { accountId, chatId } }))
}

export function clearChatRemovalFacts(): void { delete state()[KEY] }

/** Screen and parked groups supply their own ids; no second list or tombstone cache. */
export function subscribeChatRemovals(candidates: () => readonly string[], remove: (chatId: string) => void): () => void {
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
  }
  window.addEventListener(EVENT, check)
  check()
  return () => window.removeEventListener(EVENT, check)
}
