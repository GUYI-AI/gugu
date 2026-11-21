import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { refreshFailure, replica, useReplica } from '../../lib/replica'
import { chatFileMetadata } from '../../lib/fileMetadataReplica'
import { messageById } from '../../lib/messageById'
import { useChatStore } from '../../store/chatContext'
import { quotedContentView } from '../chat/quotedContent'
import { quoteSummary } from '../chat/quoteSummary'
import { GroupFileName } from './GroupFileName'
import { MentionPill } from './MentionPill'
import { linkPillTarget } from './linkPills'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messagesByIdPrefix } from '../../lib/messageIdPrefix'
import { followLink } from '../../lib/guguLinks'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { Bot, ListChecks, MessageSquare, Reply, User, Users } from '@/lib/icons'
import { listedSession, useDeviceSessions, useDirectoryDevices } from '../../session/shared/remote-sessions/session-directory'

// Reads are key-only replicas (lib/replica).
const linkedMessagePrefix = replica({ name: 'link-pill-message-prefix', scope: 'account', keep: 5 * 60_000,
  read: (accountId, chatId: string, prefix: string) => messagesByIdPrefix(chatId, prefix, accountId) })

/**
 * Each kind's mark: one line glyph in the text's colour, nothing else (owner 2026-11-16: no faces in a pill). A kind gets a
 * mark only where its words alone do not say what it is — a message's words read like any text, a task title like a
 * name, a group's name like a topic's.
 */
const MESSAGE_MARK = <Reply size={12} />
const TOPIC_MARK = <MessageSquare size={12} />
const GROUP_MARK = <Users size={12} />
const PERSON_MARK = <User size={12} />
const AGENT_MARK = <Bot size={12} />
const TASK_MARK = <ListChecks size={12} />

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
  if (target?.kind === 'session') return <SessionPill {...props} sessionId={target.sessionId} />
  return <>{props.children}</>
}

function FilePill({ href, onClick, children, rest, itemId, version }: DrawProps & { accountId: string; itemId: string; version?: number }) {
  const { t } = useTranslation('messaging')
  const reading = useReplica(chatFileMetadata, [itemId, version ?? null])
  const file = reading.state === 'value' ? reading.value : null
  const ready = file?.status === 'ready' ? file.revision : null
  // A failed read, or one again failing over the name read before (it stays drawn): greyed with the reason (❌ drawn as current).
  const reason = refreshFailure(reading) ? t('attachmentView.fileUnavailable')
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
function MessagePrefixPill({ href, onClick: _unresolved, children, rest, accountId, chatId, prefix }: DrawProps & { accountId: string; chatId: string; prefix: string }) {
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
  // Several: the same pill as any message link, saying how many; it opens the candidates (owner 2026-11-16: one look).
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger nativeButton={false} render={(props) => (
        <MentionPill href={href} icon={MESSAGE_MARK} title={t('linkPill.severalMessages', { count: found.length, prefix: `msg:${prefix}` })} rest={props}
          onClick={(event) => { event.preventDefault(); props.onClick?.(event as never) }}>
          {t('linkPill.messages', { count: found.length })}
        </MentionPill>
      )} />
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
  const reading = useReplica(messageById, messageId ? [messageId] : null)
  const message = { data: reading.state === 'value' ? reading.value : undefined, isError: refreshFailure(reading) !== null, isSuccess: reading.state === 'value' }
  let label: ReactNode = children
  let icon: ReactNode = MESSAGE_MARK
  let unavailable = false
  let named = false
  if (messageId) {
    // The same checks as opening the link (useLinkNavigation): a live message in that chat.
    const row = message.data && message.data.chat_id === chatId && !message.data.retracted_at ? message.data : null
    unavailable = message.isError || (message.isSuccess && !row)
    named = row !== null
    if (row) label = messageLabel(row, t, row.sender_user_id ? identitiesById[row.sender_user_id]?.display_name : undefined)
  } else {
    const listed = chats.find(row => row.id === chatId)
    // A group, a topic, a direct chat with a person or with an agent: the glyph the kind is drawn with, never a face.
    if (listed) {
      const peer = listed.peer_user_id ? identitiesById[listed.peer_user_id] : undefined
      // A direct chat is named by the one on the other side, as the chat list names it.
      label = listed.kind === 'group' || listed.kind === 'topic' ? listed.name : peer?.display_name ?? listed.name
      icon = listed.kind === 'topic' ? TOPIC_MARK : listed.kind === 'group' ? GROUP_MARK
        : listed.kind === 'ai' || peer?.type === 'agent' ? AGENT_MARK : PERSON_MARK
    } else { unavailable = true; icon = null }
  }
  // Unavailable: the words already name the kind, so the mark goes. A message read before whose read again failed keeps
  // its name, greyed (❌ drawn as current, ❌ its name dropped).
  if (unavailable) { if (!named) label = t(messageId ? 'linkPill.messageUnavailable' : 'linkPill.chatUnavailable'); icon = null }
  return <MentionPill href={href} icon={icon} title={unavailable ? t('linkPill.unavailable') : typeof label === 'string' ? label : ''} unavailable={unavailable} onClick={onClick} rest={rest}>{label}</MentionPill>
}

/**
 * A session (a task): the task mark and its title. Found where a click finds it: the account's session directory (every
 * machine's list, this computer's included — the one remote hosts and the task tab read; ❌ a second read of this
 * machine's list). Greyed only once every machine that could list it has been read and none does; until then it shows
 * the link's own words.
 */
function SessionPill({ href, onClick, children, rest, sessionId }: DrawProps & { accountId: string; sessionId: string }) {
  const { t } = useTranslation('messaging')
  const devices = useDirectoryDevices()
  const elsewhere = useDeviceSessions((live) => {
    const found = listedSession(devices, live, sessionId)
    // No machines yet: the account's device list has not arrived (it always holds this one), so nothing was read.
    return 'row' in found ? { title: found.row.session.title, reading: false } : { title: null, reading: devices.length === 0 || found.unread.length > 0 }
  })
  const title = elsewhere.title
  const unavailable = title === null && !elsewhere.reading
  return <MentionPill href={href} icon={unavailable ? null : TASK_MARK} title={unavailable ? t('linkPill.unavailable') : title ?? undefined}
    unavailable={unavailable} onClick={onClick} rest={rest}>{title ?? (unavailable ? t('linkPill.sessionUnavailable') : children)}</MentionPill>
}
