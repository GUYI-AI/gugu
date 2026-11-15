import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { messageReferenceBlocks, type MessageReferenceBlock } from '@gugu/session-shared/markdown/dialect'
import { followLink } from '../../lib/guguLinks'
import { messageForUser } from '../../lib/userFacingError'
import { useChatStore } from '../../store/chatContext'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { formatRelativeTime } from '../../lib/relativeTime'
import { useShownAgentName } from '../../hooks/useShownAgentName'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { WidgetBubble } from './WidgetBubble'
import { useMessageReference } from './useMessageReference'

/** Render only the shared AST's reference paragraphs. Referenced text is plain,
 * so a reference inside the original cannot start another expansion. */
export function MessageReferenceContent({ content, chatId, slotMessageId, renderText }: {
  content: string; chatId: string; slotMessageId: string; renderText: (content: string) => ReactNode
}) {
  // A text without a reference link is not parsed twice (its Markdown parses it once more).
  const hint = content.toLowerCase()
  const parsed = hint.includes('gugu-chat://') || hint.includes('gugu-widget://') ? messageReferenceBlocks(content) : null
  if (!parsed?.blocks.length) return renderText(content)
  const pieces: ReactNode[] = []
  let start = 0
  for (const block of parsed.blocks) {
    if (block.start > start) pieces.push(<span key={`text:${start}`} className="contents">{renderText(parsed.content.slice(start, block.start))}</span>)
    pieces.push(<ReferenceCard key={block.start} block={block} chatId={chatId} slotMessageId={slotMessageId} />)
    start = block.end
  }
  if (start < parsed.content.length) pieces.push(<span key={`text:${start}`} className="contents">{renderText(parsed.content.slice(start))}</span>)
  return pieces
}

function ReferenceCard({ block, chatId, slotMessageId }: { block: MessageReferenceBlock; chatId: string; slotMessageId: string }) {
  const { t } = useTranslation('messaging')
  const read = useMessageReference(block.target)
  const { identitiesById, chats } = useChatStore('identitiesById', 'chats')
  const readable = read && !(read instanceof Error) && read.status === 'readable' ? read : null
  const identity = readable?.message.sender_user_id ? identitiesById[readable.message.sender_user_id] : undefined
  const name = useShownAgentName({ name: identity?.display_name ?? '', createdAt: identity?.type === 'agent' ? identity.created_at ?? undefined : undefined })
  const frame = 'w-[340px] max-w-full min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3'
  if (read instanceof Error) return <div className={frame} role="alert">{messageForUser(read)}</div>
  if (!read) return <div className={frame} aria-busy="true">{t('message.reference.loading')}</div>
  if (read.status === 'unreadable') return <div className={frame} data-reference-unreadable>{t(block.target.kind === 'widget' ? 'message.reference.widgetUnreadable' : 'message.reference.unreadable')}</div>
  if (read.status === 'retracted') return <div className={frame} data-reference-retracted>{t(read.widget ? 'message.reference.widgetRetracted' : 'message.retracted')}</div>
  const { message, widget } = read
  const origin = () => { followLink({ kind: 'chat', chatId: message.chat_id, messageId: message.id }) }
  if (widget && message.chat_id === chatId) return <WidgetBubble message={message} slotMessageId={slotMessageId} referenceWidget={widget} />
  const chat = chats.find(chat => chat.id === message.chat_id)
  const chatName = chat ? chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name) : ''
  return <div className={frame} data-reference-readable>
    <Button variant="ghost" size="sm" className="max-w-full justify-start text-left" onClick={origin}>
      <Avatar seed={message.sender_user_id ?? undefined} name={name} avatarUrl={identity?.avatar} size={24} />
      <span className="truncate">{name}</span>
    </Button>
    <p className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
      {chatName ? <span>{chatName} · </span> : null}
      <time dateTime={message.created_at}>{formatRelativeTime(message.created_at)}</time>
    </p>
    <p className="line-clamp-3 whitespace-pre-wrap break-words">{widget?.widget.text ?? message.content}</p>
    {widget ? <p>{t('message.reference.widgetElsewhere')}</p> : null}
    <Button variant="ghost" size="sm" onClick={origin}>{t('message.reference.locate')}</Button>
  </div>
}
