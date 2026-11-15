import { viewStateCache } from '../session/renderer/lib/stores/view-state-cache'
import { useSelect } from './selectStore'
import { readViewState, takeLegacyLocalStorage, writeViewState, type ViewPanel } from './viewStateTable'

// Who was last @mentioned in a group, per account and chat: view state (lib/viewStateTable). Kept in localStorage before
// (`gugu:group-mention:<account>/<chat>`, both URI-encoded); moved over once.
const recallOf = (accountId: string, chatId: string): ViewPanel => ({ conversation: chatId, panel: 'mention-recall', account: accountId })
const LEGACY_PREFIX = 'gugu:group-mention:'
takeLegacyLocalStorage((key) => key.startsWith(LEGACY_PREFIX), (key, raw) => {
  const [account, chat] = key.slice(LEGACY_PREFIX.length).split('/').map(decodeURIComponent)
  if (account && chat && raw && raw.length <= 128) writeViewState(recallOf(account, chat), { id: raw })
})

function read(accountId: string | null | undefined, chatId: string | null | undefined): string | null {
  return accountId && chatId ? readViewState<{ id: string }>(recallOf(accountId, chatId)).id ?? null : null
}
export function useGroupMentionRecall(accountId: string | null | undefined, chatId: string | null | undefined): string | null {
  return useSelect(viewStateCache.changes, () => read(accountId, chatId))
}
/** Advisory, account-local UI memory: a send never waits on it. */
export function rememberGroupMention(accountId: string, chatId: string, id: string | null): void {
  writeViewState(recallOf(accountId, chatId), { id: id ?? undefined })
}
