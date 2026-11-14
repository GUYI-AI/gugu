import type { MessageItem } from '@gugu/core/shared/types/chat'
import { forwardQuote, type ForwardQuoteItem } from '@gugu/core/shared/ui/forwardQuote'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { useChatStore, type ChatContextValue } from '../../store/chatContext'
import { markdownPlainText } from '../../lib/markdownPlainText'

/**
 * What a forward carries, in reading order: chat messages, and words that have no chat message behind them
 * (a task's prompt and its agent's answer), under the name they were shown with; `sender: null` is the forwarder. A message's
 * `sender` names a speaker its row does not carry (what an agent sent, seen from its task). `senderId` is who said delivered
 * words: their name as this account knows it wins over the label the delivery wrote.
 */
export type ForwardPiece =
  | { kind: 'message'; message: MessageItem; sender?: string }
  | { kind: 'text'; sender: string | null; text: string; senderId?: string | null }

/** Opens the app's forward page from a view outside the chat (the task timeline); MessageForwardHost draws it. */
export const FORWARD_PIECES_OPEN = 'gugu:forward-pieces-open'

export function openForward(pieces: ForwardPiece[]): void {
  window.dispatchEvent(new CustomEvent<ForwardPiece[]>(FORWARD_PIECES_OPEN, { detail: pieces }))
}

/** The forwarder's note, and who it addresses (its @, resolved against the one chat it goes into). */
export type ForwardNote = { text: string; toUserIds: string[] }

type Send = Pick<ChatContextValue, 'forwardMessage' | 'sendMessageToChat'>

/** #2581 Files of one send forwarded together land as one send (a new one in each chat); a file forwarded alone is on its own. */
function sendsForwardedTogether(own: readonly MessageItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of own) {
    if (message.content_type === 'attachment' && message.send_group_id) counts.set(message.send_group_id, (counts.get(message.send_group_id) ?? 0) + 1)
  }
  for (const [group, count] of counts) if (count < 2 || count > 10) counts.delete(group)
  return counts
}
type Names = {
  /** A name this account knows for a user (`null` = the forwarder), if any: a big group's profiles load lazily, a member may have left. */
  knownName: (userId: string | null) => string | undefined
  /** Said for a speaker no name is known for (the chat's own 「未知成员」). */
  unknownName: string
}

const nameOf = (userId: string | null, names: Names) => names.knownName(userId) ?? names.unknownName

/** Who said a plain-text piece, by name. */
export function pieceSender(piece: Extract<ForwardPiece, { kind: 'text' }>, names: Names): string {
  return (piece.senderId ? names.knownName(piece.senderId) : undefined) ?? piece.sender ?? nameOf(null, names)
}

/**
 * One forward into each picked chat. Words (text messages and plain text) go as one message: the note, then each piece
 * quoted under who said it, one piece too (a line forwarded alone is the one that most needs its speaker). Files, widgets
 * and cards go as themselves, after the words; with nothing to quote, the note follows them. The message carrying the note
 * addresses whom the note @-ed, the way a message typed in that chat would.
 *
 * Chats are written to one after another; `sent` hears each one done, so a failure part-way (the outbox refusing a write)
 * can tell which chats already have their copy.
 */
export async function forwardToChats(pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: ForwardNote, io: Send & Names,
  sent: (chatId: string) => void = () => {}): Promise<void> {
  const words: { quote: ForwardQuoteItem; message?: MessageItem }[] = []
  const own: MessageItem[] = []
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      if (piece.text.trim()) words.push({ quote: { sender: pieceSender(piece, io), text: piece.text } })
      continue
    }
    const { message } = piece
    if (message.content_type !== 'text') { own.push(message); continue }
    if (message.retracted_at || !message.content?.trim()) continue
    words.push({ message, quote: {
      sender: piece.sender ?? nameOf(message.sender_user_id, io),
      text: message.content,
      replyTo: message.reply_to_content ? { sender: message.reply_to_sender_user_id ? nameOf(message.reply_to_sender_user_id, io) : io.unknownName, text: markdownPlainText(message.reply_to_content) } : null,
    } })
  }
  const quoted = words.length > 0
  const body = quoted ? forwardQuote(words.map(word => word.quote), note.text) : null
  const addressed = { toUserIds: note.toUserIds }
  // A chat message among the words keeps the link to where they came from (read rights, the forwarded badge).
  const source = words.find(word => word.message)?.message
  const together = sendsForwardedTogether(own)
  for (const chatId of targetChatIds) {
    const landed = new Map([...together].map(([group, size]) => [group, { id: crypto.randomUUID(), size }]))
    if (body !== null) {
      if (source) await io.forwardMessage({ ...source, content: body, reply_to_message_id: null, reply_to_content: null, reply_to_sender_user_id: null }, chatId, addressed)
      else await io.sendMessageToChat(chatId, body, addressed)
    }
    for (const message of own) {
      const sendGroup = message.send_group_id ? landed.get(message.send_group_id) : undefined
      await (sendGroup ? io.forwardMessage(message, chatId, { sendGroup }) : io.forwardMessage(message, chatId))
    }
    if (!quoted && note.text.trim()) await io.sendMessageToChat(chatId, note.text.trim(), addressed)
    sent(chatId)
  }
}

/** `forwardToChats` with this account's chat store: senders named as the chat names them. */
export function useForwardToChats() {
  const { forwardMessage, sendMessageToChat } = useChatStore('forwardMessage', 'sendMessageToChat')
  const names = useForwardNames()
  return useCallback((pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: ForwardNote, sent?: (chatId: string) => void) =>
    forwardToChats(pieces, targetChatIds, note, { forwardMessage, sendMessageToChat, ...names }, sent), [forwardMessage, sendMessageToChat, names])
}

/** Names as this account's chat store knows them. */
export function useForwardNames(): Names {
  const { identitiesById } = useChatStore('identitiesById')
  const { user } = useAuth()
  const { t } = useTranslation('messaging')
  return useMemo(() => ({
    knownName: (userId: string | null) => {
      const id = userId ?? user?.id
      return (id ? identitiesById[id]?.display_name : undefined) || undefined
    },
    unknownName: t('group.memberFallback.unknown'),
  }), [identitiesById, user, t])
}
