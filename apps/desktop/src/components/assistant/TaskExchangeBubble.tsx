import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useContactsStore } from '../../store/contactsContext'
import { taskExchangeContent } from './taskExchangeContent'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { downloadAttachment } from '@/lib/attachmentBytes'
import { messageForUser } from '@/lib/userFacingError'
import { useToast } from '../toastContext'
import { Markdown } from '../markdown/Markdown'
import { MediaAttachmentBubble } from '../chat/MediaAttachmentBubble'
import { ReadOnlyMessageBubble } from '../chat/ReadOnlyMessageBubble'

/** Read-only collaboration evidence: it has no IM reactions, delete action, or read watermark. */
export function TaskExchangeBubble({ message, mobile, onOpenFile }: { message: MessageItem; recipientUserId: string; mobile: boolean; onOpenFile?: (file: ParsedAttachment) => void }) {
  const { contacts } = useContactsStore()
  const { t } = useTranslation('assistant')
  const { t: tm } = useTranslation('messaging')
  const { toast } = useToast()
  const body = taskExchangeContent(message.content ?? '')
  const sender = contacts.find((contact) => contact.id === message.sender_user_id)
  const download = async (file: ParsedAttachment) => {
    try { await downloadAttachment(file.source, file.fileName) }
    catch (error) { toast(tm('chatArea.downloadFailed'), 'error', messageForUser(error)) }
  }
  if (!body.text && body.files.length === 0 && !body.invalidAttachments) return null
  return <ReadOnlyMessageBubble message={message} mobile={mobile}
    sender={{ display_name: sender?.display_name ?? t('tasks.agent'), avatar: sender?.avatar, type: 'agent' }}>
    {body.text && <Markdown trust="chat" content={body.text} />}
    {body.files.map((file, index) => <MediaAttachmentBubble key={`${file.source.kind === 'attachment' ? file.source.attachmentId : index}:${index}`}
      meta={file} messageId={message.id} isMine={message.is_mine} onOpenFile={onOpenFile} onDownload={() => void download(file)} />)}
    {body.invalidAttachments && <span role="alert">{tm('attachmentView.fileUnavailable')}</span>}
  </ReadOnlyMessageBubble>
}
