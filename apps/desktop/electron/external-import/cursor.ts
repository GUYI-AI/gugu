import type { LibraryConfig, Session } from 'cursor-history'
import type {
  ExternalConversation,
  ExternalMessage,
} from '../../src/session/shared/core/session-import/external-conversation-import'

function cursorConversation(session: Session): ExternalConversation | null {
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
  return {
    sourceId: session.id,
    title: session.title?.trim() || messages[0].text.trim().slice(0, 120),
    messages,
  }
}

export async function readCursorHistory(
  signal: AbortSignal,
  { dataPath, sqliteDriver = 'better-sqlite3' }: Pick<LibraryConfig, 'dataPath' | 'sqliteDriver'> = {},
) {
  const cursor = await import('cursor-history')
  const options = { dataPath, signal, sqliteDriver }
  const readContext = cursor.createSessionReadContext(options)
  const config = { ...options, readContext }
  const rows: ExternalConversation[] = []
  let failed = 0
  try {
    const summaries = await cursor.listSessionSummaries(config)
    for (const summary of summaries.data) {
      signal.throwIfAborted()
      if (summary.resolutionState === 'ambiguous') {
        failed++
        continue
      }
      try {
        const session = await cursor.getSession(summary.id, { ...config, messageFilter: ['user', 'assistant'] })
        const conversation = cursorConversation(session)
        if (conversation) rows.push(conversation)
      } catch {
        signal.throwIfAborted()
        failed++
      }
    }
  } catch (error) {
    if (!cursor.isDatabaseNotFoundError(error)) throw error
  } finally {
    await readContext.dispose()
  }
  return { rows, failed }
}
