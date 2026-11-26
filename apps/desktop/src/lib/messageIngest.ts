import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageStore, ImMessageBatch, ImMessagePage, ImMessagePageResult, ImMessageWrite } from '../session/shared/core/im-messages'
import type { imMessagesController } from '../../electron/session/main/core/im-messages/controller'
import { createRPCClient } from '../session/shared/lib/ipc/rpc'
import { desktopIpc } from '../platform/desktopIpc'
import { createLocalMessageStore } from './localMessageStore'
import { acceptMessageWrites, clearMessageWindows, initializeMessageWindows, messageAccountClosed, messageWindow, messageWindowGeneration, setMessageWindow } from './messageWindows'
import { MAX_WINDOW } from '../store/chatMessageWindow'
const commits = new Map<string, Promise<unknown>>()
/** One store per IndexedDB factory: the page has exactly one (unit tests hand each case a fresh one). */
let phoneStore: { factory: IDBFactory; store: ReturnType<typeof createLocalMessageStore> } | undefined

function phoneMessages(): ReturnType<typeof createLocalMessageStore> {
  if (phoneStore?.factory !== globalThis.indexedDB) phoneStore = { factory: globalThis.indexedDB, store: createLocalMessageStore() }
  return phoneStore.store
}

/**
 * @@@client-state-model - the one place a platform picks where the message store runs: the desktop's session SQLite in
 * the main process, or the same contract over IndexedDB in this renderer. Everything else is platform-free.
 */
function store(): MessageStore {
  const bridge = desktopIpc()
  if (bridge) return createRPCClient<{ imMessages: typeof imMessagesController }>(bridge.invoke).imMessages
  return phoneMessages()
}

/** Native has already proved deletion. Drain this renderer; the desktop's native
 * receiver retired SQLite, while the phone must also retire its separate DB.
 */
export async function retireClosedMessageAccount(accountId: string): Promise<void> {
  clearMessageWindows(accountId)
  await commits.get(accountId)?.then(() => undefined, () => undefined)
  if (!desktopIpc()) await phoneMessages().retireAccount(accountId)
}

/** Read-only access cannot acquire either renderer write method. */
export function localMessageQueries(): Omit<MessageStore, 'ingest' | 'clearAccount'> {
  const { windows, page, search, throughRevision } = store()
  return { windows, page, search, throughRevision }
}

export function initializeMessages(accountId: string): void {
  initializeMessageWindows(accountId)
}

/** All renderer writes to the local store, including clears, enter here. */
export async function ingestMessages(accountId: string, batch: ImMessageBatch | 'clear' | (() => ImMessageBatch)): Promise<ImMessageWrite[]> {
  if (batch !== 'clear' && messageAccountClosed(accountId)) throw new DOMException('Local message account is closed', 'AbortError')
  const resolved = typeof batch === 'function' ? batch() : batch
  // A write belongs to the store and the window generation of the moment it was asked for.
  const target = { store: store(), generation: messageWindowGeneration(accountId) }
  const commit = () => commitMessages(accountId, resolved, target)
  const run: Promise<ImMessageWrite[]> = (commits.get(accountId) ?? Promise.resolve()).then(commit, commit)
  commits.set(accountId, run)
  const settle = () => { if (commits.get(accountId) === run) commits.delete(accountId) }
  void run.then(settle, settle)
  return run
}

async function commitMessages(accountId: string, batch: ImMessageBatch | 'clear',
  target: { store: MessageStore; generation: number }): Promise<ImMessageWrite[]> {
  const imMessages = target.store
  if (batch === 'clear') {
    await imMessages.clearAccount(accountId)
    clearMessageWindows(accountId)
    return []
  }
  // A page arriving after explicit logout must not recreate the just-cleared local history.
  if (messageAccountClosed(accountId)) throw new DOMException('Local message account is closed', 'AbortError')
  const accepted = await imMessages.ingest(accountId, batch)
  // Windows rebuilt since (the account opened again) were read from the store; they are not this write's to change.
  if (messageWindowGeneration(accountId) !== target.generation) return accepted
  const reads = acceptMessageWrites(accountId, accepted)
  await publishWindows(accountId, reads.filter(read => !read.root).map(read => read.chatId), imMessages)
  for (const { chatId, root } of reads) if (root) {
    const page = await imMessages.page(accountId, { chatId, threadRootId: root, limit: MAX_WINDOW })
    setMessageWindow(accountId, chatId, root, page.rows)
  }
  return accepted
}

async function publishWindows(accountId: string, chatIds: string[], from = store()): Promise<void> {
  if (!chatIds.length) return
  const rows = await from.windows(accountId, chatIds, MAX_WINDOW)
  for (const chatId of chatIds) setMessageWindow(accountId, chatId, null, rows.filter(row => row.chat_id === chatId))
}

export async function prefetchMessages(accountId: string, chatIds: string[]): Promise<void> {
  if (messageWindow(accountId, '') !== null) await publishWindows(accountId, chatIds)
}

export function readMessagePage(accountId: string, page: ImMessagePage): Promise<ImMessagePageResult> {
  return store().page(accountId, page)
}

export async function ingestMessagePage(accountId: string, rows: MessageItem[], chatId: string,
  limit: number, beforeSeq?: number, afterSeq?: number, threadRootId: string | null = null, rawCount = rows.length): Promise<void> {
  const fromSeq = afterSeq !== undefined ? afterSeq + 1 : rawCount < limit ? 1 : rows[0]?.seq
  const toSeq = beforeSeq !== undefined ? beforeSeq - 1 : rows[rows.length - 1]?.seq
  await ingestMessages(accountId, { writes: rows.map(message => ({ type: 'put', message })), revisions: [],
    ranges: fromSeq !== undefined && toSeq !== undefined && fromSeq <= toSeq
      ? [{ chatId, threadRootId, fromSeq, toSeq }] : [] })
}
