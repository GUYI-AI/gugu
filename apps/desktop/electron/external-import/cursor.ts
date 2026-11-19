import type { LibraryConfig, Session } from 'cursor-history'
import type {
  ExternalConversation, ExternalMessage, ExternalImportBatch,
} from '../../src/session/shared/core/session-import/external-conversation-import'
import type { ExternalHistoryStore } from './store'

function cursorConversation(session: Session, title: string | null): ExternalConversation | null {
  const activeBranch = session.activeBranchMessageIds?.length ? new Set(session.activeBranchMessageIds) : null
  const messages: ExternalMessage[] = []
  for (const message of session.messages) {
    if (message.isSidechain || (activeBranch && (!message.id || !activeBranch.has(message.id)))) continue
    const { role, content } = message
    if ((role !== 'user' && role !== 'assistant') || !content.trim()) continue
    if (content === '[corrupted message]' || content === '[empty message]') continue
    const time = Date.parse(message.timestamp)
    messages.push({ role, text: content, at: Number.isFinite(time) ? time : null })
  }
  if (!messages.length) return null
  return { sourceId: session.id, title: title?.trim() || messages[0].text.trim().slice(0, 120), messages }
}

export type CursorSelection = { rows: { sourceId: string; title: string | null }[]; failed: number }
type Options = Pick<LibraryConfig, 'dataPath' | 'sqliteDriver'>

/** Summary catalog only. In particular, do not hydrate getSession just to count conversations. */
export async function scanCursorHistory(signal: AbortSignal, { dataPath, sqliteDriver = 'better-sqlite3' }: Options = {}): Promise<CursorSelection> {
  const cursor = await import('cursor-history')
  const options = { dataPath, signal, sqliteDriver }
  const readContext = cursor.createSessionReadContext(options)
  const result: CursorSelection = { rows: [], failed: 0 }
  try {
    const summaries = await cursor.listSessionSummaries({ ...options, readContext })
    for (const summary of summaries.data) {
      signal.throwIfAborted()
      if (summary.resolutionState === 'ambiguous') result.failed++
      else result.rows.push({ sourceId: summary.id, title: summary.title })
    }
  } catch (error) {
    if (!cursor.isDatabaseNotFoundError(error)) throw error
  } finally { await readContext.dispose() }
  return result
}

/** Hydrate only the requested batch, persist in this child, and return metadata rather than bodies. */
export async function importCursorHistoryBatch(
  { owner, selection, offset, size }: { owner: string; selection: CursorSelection; offset: number; size: number },
  store: Pick<ExternalHistoryStore, 'has' | 'import'>,
  signal: AbortSignal,
  { dataPath, sqliteDriver = 'better-sqlite3' }: Options = {},
): Promise<ExternalImportBatch> {
  const cursor = await import('cursor-history')
  const options = { dataPath, signal, sqliteDriver }
  const readContext = cursor.createSessionReadContext(options)
  const result: ExternalImportBatch = {
    imported: [], alreadyImported: 0, failed: offset === 0 ? selection.failed : 0,
    done: Math.min(offset + size, selection.rows.length) + selection.failed,
    total: selection.rows.length + selection.failed,
  }
  try {
    for (const summary of selection.rows.slice(offset, offset + size)) {
      signal.throwIfAborted()
      try {
        if (store.has(owner, 'cursor', summary.sourceId)) { result.alreadyImported++; continue }
        const session = await cursor.getSession(summary.sourceId, { ...options, readContext, messageFilter: ['user', 'assistant'] })
        const conversation = cursorConversation(session, summary.title)
        if (!conversation) { result.failed++; continue }
        const added = store.import(owner, 'cursor', conversation)
        if (added) result.imported.push(added)
        else result.alreadyImported++
      } catch {
        signal.throwIfAborted()
        result.failed++
      }
    }
  } finally { await readContext.dispose() }
  return result
}
