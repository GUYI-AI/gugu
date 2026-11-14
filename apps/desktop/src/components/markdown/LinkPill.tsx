import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { readModel, useReadModel } from '../../lib/readModel'
import { fileMetadata } from '../../lib/fileAccess'
import { chatService } from '../../lib/chat'
import { useChatStore } from '../../store/chatContext'
import { quotedContentView } from '../chat/quotedContent'
import { quoteSummary } from '../chat/quoteSummary'
import { GroupFileName } from './GroupFileName'
import { MentionPill } from './MentionPill'
import { linkPillTarget } from './linkPills'

// Reads are key-only read models (lib/readModel).
const linkedFile = readModel({ name: 'link-pill-file', scope: 'account', keep: 5 * 60_000,
  read: (_accountId, itemId: string, version: number | null) => fileMetadata(itemId, version ?? undefined) })
const linkedMessage = readModel({ name: 'link-pill-message', scope: 'account', keep: 5 * 60_000,
  read: (accountId, messageId: string) => chatService.getMessageById(messageId, accountId) })

type DrawProps = {
  href: string
  onClick: (event: MouseEvent) => void
  children: ReactNode
  rest?: Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'title' | 'onClick' | 'children' | 'className'>
}

/**
 * A chat link drawn in place as the file mention chip: a file by its name, a group or topic as `# name`, a message as
 * `sender: its first words`, each read as the person reading. Until the read answers it shows the link's own words; a
 * target that read cannot show is greyed, with the reason on hover. Drawn only where it can read (Markdown's LinkPillGate).
 */
export function LinkPill(props: DrawProps & { accountId: string }) {
  const target = linkPillTarget(props.href)
  if (target?.kind === 'file') return <FilePill {...props} itemId={target.itemId} version={target.version} />
  if (target?.kind === 'chat') return <ChatPill {...props} chatId={target.chatId} messageId={target.messageId} />
  return <>{props.children}</>
}

function FilePill({ href, onClick, children, rest, itemId, version }: DrawProps & { accountId: string; itemId: string; version?: number }) {
  const { t } = useTranslation('messaging')
  const reading = useReadModel(linkedFile, [itemId, version ?? null])
  const file = reading.state === 'value' ? reading.value : null
  const ready = file?.status === 'ready' ? file.revision : null
  const reason = reading.state === 'error' ? t('attachmentView.fileUnavailable')
    : file && file.status !== 'ready' ? t(file.status === 'gone' ? 'attachmentView.fileGone' : file.status === 'expired' ? 'attachmentView.fileExpired' : 'attachmentView.fileMissing')
      : ready?.source === 'local' && ready.host_online === false ? t('attachmentView.holderOffline', { machine: ready.host_label ?? t('attachmentView.holderMachine') }) : null
  // Named the way the file list names it (GroupFileName, 摩擦单 F39): the file's own name once read, the link's words before.
  const name = ready?.file_name ?? (typeof children === 'string' ? children : null)
  return <MentionPill href={href} file title={reason ?? ready?.file_name ?? ''} unavailable={reason !== null} onClick={onClick} rest={rest}>
    {name !== null ? <GroupFileName name={name} /> : children}
  </MentionPill>
}

function ChatPill({ href, onClick, children, rest, chatId, messageId }: DrawProps & { accountId: string; chatId: string; messageId?: string }) {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const reading = useReadModel(linkedMessage, messageId ? [messageId] : null)
  const message = { data: reading.state === 'value' ? reading.value : undefined, isError: reading.state === 'error', isSuccess: reading.state === 'value' }
  let label: ReactNode = children
  let unavailable = false
  if (messageId) {
    // The same checks as opening the link (useLinkNavigation): a live message in that chat.
    const row = message.data && message.data.chat_id === chatId && !message.data.retracted_at ? message.data : null
    unavailable = message.isError || (message.isSuccess && !row)
    if (row) {
      const sender = row.sender_user_id ? identitiesById[row.sender_user_id]?.display_name : undefined
      const words = quoteSummary(parseAttachmentContent(row.content)?.fileName ?? quotedContentView(widgetMessagePreview(row.content) ?? row.content).text)
      label = sender ? t('linkPill.message', { sender, words }) : words
    }
  } else {
    const listed = chats.find(row => row.id === chatId)
    // A group or topic reads as a channel, a direct chat as its name; one this window does not list keeps the link's words.
    if (listed) label = listed.kind === 'group' || listed.kind === 'topic' ? `# ${listed.name}` : listed.name
  }
  return <MentionPill href={href} title={unavailable ? t('linkPill.unavailable') : typeof label === 'string' ? label : ''} unavailable={unavailable} onClick={onClick} rest={rest}>{label}</MentionPill>
}
