import { useEffect, useState } from 'react'
import { markdownPlainText } from '../../lib/markdownPlainText'
import { LiveForwardMessageDialog } from './ForwardMessageDialog'
import { FORWARD_PIECES_OPEN, pieceSender, useForwardNames, useForwardToChats, type ForwardPiece } from './forwardToChats'

/** The forward page for a view outside the chat (the task timeline, desktop and phone): the chat's own page and forward. */
export function MessageForwardHost() {
  const [pieces, setPieces] = useState<ForwardPiece[] | null>(null)
  const forwardTo = useForwardToChats()
  const names = useForwardNames()
  useEffect(() => {
    const open = (event: Event) => setPieces((event as CustomEvent<ForwardPiece[]>).detail)
    window.addEventListener(FORWARD_PIECES_OPEN, open)
    return () => window.removeEventListener(FORWARD_PIECES_OPEN, open)
  }, [])
  if (!pieces?.length) return null
  const messages = pieces.flatMap(piece => piece.kind === 'message' ? [piece.message] : [])
  // Every piece in reading order, one line each; the line the page shows is the last, the bubble that was pressed.
  const words = pieces.flatMap(piece => piece.kind === 'text' ? [`${pieceSender(piece, names)}：${markdownPlainText(piece.text)}`] : [])
  const preview = words.length ? words.join('\n') : undefined
  return (
    <LiveForwardMessageDialog
      messages={messages}
      preview={preview}
      sourceChatId={messages[0]?.chat_id ?? ''}
      onForward={(targetChatIds, note, sent) => forwardTo(pieces, targetChatIds, note, sent)}
      onClose={() => setPieces(null)}
    />
  )
}
