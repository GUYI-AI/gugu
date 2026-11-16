import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { replica, useReplica } from '../../lib/replica'
import { fileMetadata } from '../../lib/fileAccess'
import { chatService } from '../../lib/chat'
import { useChatStore } from '../../store/chatContext'
import { quotedContentView } from '../chat/quotedContent'
import { quoteSummary } from '../chat/quoteSummary'
import { GroupFileName } from './GroupFileName'
import { MentionPill } from './MentionPill'
import { linkPillTarget } from './linkPills'
import { FILE_PILL_CLASS } from './filePills'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messagesByIdPrefix } from '../../lib/messageIdPrefix'
import { followLink } from '../../lib/guguLinks'
import { DropdownMenu, MenuItem } from '../ui/Menu'

// Reads are key-only replicas (lib/replica).
const linkedFile = replica({ name: 'link-pill-file', scope: 'account', keep: 5 * 60_000,
  read: (_accountId, itemId: string, version: number | null) => fileMetadata(itemId, version ?? undefined) })
const linkedMessage = replica({ name: 'link-pill-message', scope: 'account', keep: 5 * 60_000,
  read: (accountId, messageId: string) => chatService.getMessageById(messageId, accountId) })
const linkedMessagePrefix = replica({ name: 'link-pill-message-prefix', scope: 'account', keep: 5 * 60_000,
  read: (accountId, chatId: string, prefix: string) => messagesByIdPrefix(chatId, prefix, accountId) })

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
  if (target?.kind === 'chat' && target.messagePrefix) return <MessagePrefixPill {...props} chatId={target.chatId} prefix={target.messagePrefix} />
  if (target?.kind === 'chat') return <ChatPill {...props} chatId={target.chatId} messageId={target.messageId} />
  return <>{props.children}</>
}

function FilePill({ href, onClick, children, rest, itemId, version }: DrawProps & { accountId: string; itemId: string; version?: number }) {
  const { t } = useTranslation('messaging')
  const reading = useReplica(linkedFile, [itemId, version ?? null])
  const file = reading.state === 'value' ? reading.value : null
  const ready = file?.status === 'ready' ? file.revision : null
  const reason = reading.state === 'error' ? t('attachmentView.fileUnavailable')
    : file && file.status !== 'ready' ? t(file.status === 'gone' ? 'attachmentView.fileGone' : file.status === 'expired' ? 'attachmentView.fileExpired' : 'attachmentView.fileMissing')
      : ready?.source === 'local' && ready.host_online === false ? t('attachmentView.holderOffline', { machine: ready.host_label ?? t('attachmentView.holderMachine') }) : null
  // Named the way the file list names it (GroupFileName, 摩擦单 F39): the file's own name once read, the link's words before.
  const name = ready?.file_name ?? (typeof children === 'string' ? children : null)
  return <MentionPill href={href} file={name ?? ''} title={reason ?? ready?.file_name ?? ''} unavailable={reason !== null} onClick={onClick} rest={rest}>
    {name !== null ? <GroupFileName name={name} /> : children}
  </MentionPill>
}

/**
 * `msg:<prefix>` in a message (owner 2026-11-16), resolved in that message's own chat: one match is that message's pill
 * and opens it like any message link; several offer the candidates; none stays the words as written, saying so on hover.
 */
function MessagePrefixPill({ onClick: _unresolved, children, rest, accountId, chatId, prefix }: DrawProps & { accountId: string; chatId: string; prefix: string }) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const reading = useReplica(linkedMessagePrefix, [chatId, prefix])
  const found = reading.state === 'value' ? reading.value : null
  const open = (messageId: string) => followLink(conversationLink(chatId, messageId))
  if (found?.length === 1) {
    const href = conversationLink(chatId, found[0]!.id)
    return <ChatPill href={href} onClick={(event) => { event.preventDefault(); open(found[0]!.id) }} rest={rest} accountId={accountId} chatId={chatId} messageId={found[0]!.id}>{children}</ChatPill>
  }
  if (found?.length === 0 || reading.state === 'error') return <span title={t('linkPill.noSuchMessage', { prefix: `msg:${prefix}` })}>{children}</span>
  if (!found) return <>{children}</>
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className={`gg-md-mention ${FILE_PILL_CLASS}`} data-mention-kind="link" title={t('linkPill.severalMessages', { count: found.length, prefix: `msg:${prefix}` })}>
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content className="max-w-[360px]">
        {found.map((row) => <MenuItem key={row.id} onClick={() => open(row.id)}>{messageLabel(row, t, identitiesById[row.sender_user_id ?? '']?.display_name)}</MenuItem>)}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

/** A message as a pill names it: `sender: its first words`. */
function messageLabel(row: MessageItem, t: ReturnType<typeof useTranslation<'messaging'>>['t'], sender: string | undefined): string {
  const words = quoteSummary(parseAttachmentContent(row.content)?.fileName ?? quotedContentView(widgetMessagePreview(row.content) ?? row.content).text)
  return sender ? t('linkPill.message', { sender, words }) : words
}

function ChatPill({ href, onClick, children, rest, chatId, messageId }: DrawProps & { accountId: string; chatId: string; messageId?: string }) {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const reading = useReplica(linkedMessage, messageId ? [messageId] : null)
  const message = { data: reading.state === 'value' ? reading.value : undefined, isError: reading.state === 'error', isSuccess: reading.state === 'value' }
  let label: ReactNode = children
  let unavailable = false
  if (messageId) {
    // The same checks as opening the link (useLinkNavigation): a live message in that chat.
    const row = message.data && message.data.chat_id === chatId && !message.data.retracted_at ? message.data : null
    unavailable = message.isError || (message.isSuccess && !row)
    if (row) label = messageLabel(row, t, row.sender_user_id ? identitiesById[row.sender_user_id]?.display_name : undefined)
  } else {
    const listed = chats.find(row => row.id === chatId)
    // A group or topic reads as a channel, a direct chat as its name; one this window does not list keeps the link's words.
    if (listed) label = listed.kind === 'group' || listed.kind === 'topic' ? `# ${listed.name}` : listed.name
  }
  return <MentionPill href={href} title={unavailable ? t('linkPill.unavailable') : typeof label === 'string' ? label : ''} unavailable={unavailable} onClick={onClick} rest={rest}>{label}</MentionPill>
}
