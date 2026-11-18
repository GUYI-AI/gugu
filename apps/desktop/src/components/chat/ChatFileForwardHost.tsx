import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_FORWARD_FILES_EVENT, type AppForwardFilesDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { useAuth } from '../../store/auth'
import { LiveForwardMessageDialog } from './ForwardMessageDialog'
import { useForwardToChats, type ForwardPiece } from './forwardToChats'

/**
 * The folder's 「转发」 (`files.forward`, desktop and phone): the chat's own forward page. Each chat picked gets one file card
 * per file, as forwarding several messages sends one message each; the folder's own chat is left out, as a message's is.
 * A working copy's files are in no chat: what they hold goes as attachments.
 */
export function ChatFileForwardHost() {
  const { t } = useTranslation('messaging')
  const forwardTo = useForwardToChats()
  const { user } = useAuth()
  const [request, setRequest] = useState<Extract<AppForwardFilesDetail, { files: unknown }> | { copies: File[] } | null>(null)
  useEffect(() => {
    // A working copy's bytes become Files at once: kept as they came, a large one would be held twice while the page is up.
    const open = (event: Event) => {
      const detail = (event as CustomEvent<AppForwardFilesDetail>).detail
      setRequest('copies' in detail ? { copies: detail.copies.map(({ name, bytes }) => new File([bytes], name)) } : detail)
    }
    window.addEventListener(APP_FORWARD_FILES_EVENT, open)
    return () => window.removeEventListener(APP_FORWARD_FILES_EVENT, open)
  }, [])
  if (!request || !user) return null
  // The note follows the files, as a forward's note follows what has no words to quote.
  const named = 'copies' in request ? request.copies : request.files
  const pieces: ForwardPiece[] = 'copies' in request
    ? [{ kind: 'files', files: async () => request.copies }]
    : request.files.map((file) => ({ kind: 'folder', file }))
  const [only] = named
  return (
    <LiveForwardMessageDialog
      sourceChatId={'copies' in request ? '' : request.chatId}
      preview={named.length === 1 && only ? only.name : t('forward.filesPreview', { count: named.length })}
      onForward={(targetChatIds, note, sent) => forwardTo(pieces, targetChatIds, note, sent)}
      onClose={() => setRequest(null)}
    />
  )
}
