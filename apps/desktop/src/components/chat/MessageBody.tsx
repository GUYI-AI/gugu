import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { classifyFileLink } from '@gugu/core/shared/ui/guguLink'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { formatVoiceDuration, parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import { openSenderFile } from '@/lib/openMessageSender'
import { Markdown } from '../markdown/Markdown'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { ComposerCardView } from './ComposerCardView'
import { MediaAttachmentBubble } from './MediaAttachmentBubble'
import { parseQuotedContent, partialQuotedContent } from './messageQuoteContent'
import { QuestionCardView } from './QuestionCardView'
import type { MentionRender } from './useMentionRender'
import { WidgetBubble } from './WidgetBubble'

/**
 * What one message says, drawn by its content_type: card, question, widget, attachment (voice / media), text.
 * The frame around it (avatar, sender, time, read receipt, reactions, menus) belongs to whoever hosts it.
 * One kind of message has this one renderer; a new kind is added here, not in a host.
 */
export function MessageBody({
  message: msg, compact, isGroup, senderName, time, mention, memberProfiles, onOpenTopic, onOpenFile, onOpenWorkspaceFile,
}: {
  message: MessageItem
  /** Phone layout. */
  compact: boolean
  isGroup: boolean
  senderName: string
  /** Cards write their own time on their last row. */
  time: ReactNode
  mention?: Pick<MentionRender, 'content' | 'mentionMarker'>
  memberProfiles?: Record<string, MemberProfileCardModel>
  onOpenTopic?: (messageId: string) => void
  onOpenFile?: (meta: ParsedAttachment, message?: MessageItem) => void
  /** A link to a file in the sender's working folder. Default: open it through the sender; a task timeline opens it in that task. */
  onOpenWorkspaceFile?: (link: Extract<ReturnType<typeof classifyFileLink>, { kind: 'workspace-file' }>) => void
}) {
  const { t } = useTranslation('messaging')
  const card = msg.content_type === 'card' ? parseComposerCard(msg.content) : null
  if (card?.type === 'question') return <QuestionCardView card={card} chatId={msg.chat_id} messageId={msg.id} agentUserId={msg.sender_user_id ?? ''} time={time} />
  if (card) return <ComposerCardView card={card} isMine={msg.is_mine} isGroup={isGroup} chatId={msg.chat_id} senderName={senderName} time={time} memberProfiles={memberProfiles} onOpenTopic={compact && onOpenTopic && card.type === 'task' ? () => onOpenTopic(msg.id) : undefined} onOpenFile={onOpenFile} />
  if (msg.content_type === 'widget') return <WidgetBubble message={msg} />
  if (msg.content_type === 'attachment') {
    const voice = parseVoiceAttachmentContent(msg.content)
    if (voice) return <VoiceAttachmentBubble fileName={voice.fileName} durationMs={voice.durationMs} transcript={voice.transcript} isMine={msg.is_mine} />
    const media = parseAttachmentContent(msg.content, msg)
    if (media) return <MediaAttachmentBubble meta={media} messageId={msg.id} isMine={msg.is_mine} onOpenFile={onOpenFile ? (file) => onOpenFile(file, msg) : undefined} senderName={senderName} chatId={msg.chat_id} />
    return <span style={{ color: 'var(--text-link)' }}>{t('message.attachment')}</span>
  }
  return <div style={compact ? { alignSelf: 'stretch', minWidth: 0, maxWidth: '100%' } : { display: 'contents' }}>{(() => {
    const partial = partialQuotedContent(msg)
    const raw = partial?.replyText ?? msg.content ?? ''
    const quoted = partial ? null : parseQuotedContent(raw)
    if (quoted && quoted.replyText) {
      return (
        // flex column + alignItems:flex-start → each child shrinks to its own content width
        // quote block won't stretch the bubble beyond reply text width
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          {quoted.replyText && (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {quoted.replyText}
            </div>
          )}
          {/* overflow:hidden + maxWidth together cap max-content contribution to parent fit-content */}
          <div style={{
            display: 'inline-block',
            overflow: 'hidden',
            borderLeft: `3px solid ${msg.is_mine ? 'var(--bubble-quote-bar-mine)' : 'var(--bubble-quote-bar-other)'}`,
            paddingLeft: '7px',
            maxWidth: '160px',
          }}>
            {quoted.senderName && (
              <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, opacity: 0.6, marginBottom: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {quoted.senderName}
              </div>
            )}
            <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {quoted.quoteText}
            </div>
          </div>
        </div>
      )
    }
    // #1515 段内软换行渲成 <br>:人手打的和 agent 发的一样(agent 群消息是给人在手机上看的,换行都是有意分行;与会话 transcript 一致)。
    // @@@2017 群内定向消息:渲染注入 nonce marker 后的正文(mention.content),并把本次 marker 传下 →
    // 只有被 to_user_ids 背书的 @Name 才渲成 mention;非群/whisper → content=undefined 用原始 raw、marker 空。
    return <Markdown trust="chat" content={partial ? raw : mention?.content ?? raw} onAccent={msg.is_mine} hardBreaks mentionMarker={mention?.mentionMarker} onOpenLink={(href) => { const link = classifyFileLink(href); if (link.kind === 'workspace-file' && onOpenWorkspaceFile) { onOpenWorkspaceFile(link); return true } if (link.kind !== 'workspace-file' || !msg.sender_user_id) return false; openSenderFile(msg.sender_user_id, isGroup ? msg.chat_id : undefined, link); return true }} />
  })()}</div>
}

function VoiceAttachmentBubble({
  fileName,
  durationMs,
  transcript,
  isMine,
}: {
  fileName: string
  durationMs: number
  transcript: string
  isMine: boolean
}) {
  const { t } = useTranslation('messaging')
  const accentColor = isMine ? 'var(--text-on-bubble-strong)' : 'var(--text-link)'
  const barColor = isMine ? 'var(--text-on-bubble-muted)' : 'var(--text-quote-author)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '148px', maxWidth: '220px' }}>
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '3px',
          height: '20px',
          padding: '2px 0',
        }}
      >
        {[8, 14, 11, 17].map((height, idx) => (
          <span
            key={idx}
            style={{
              width: '3px',
              height: `${height}px`,
              borderRadius: 'var(--radius-capsule)',
              background: barColor,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--font-body)', fontWeight: 600, color: accentColor }}>
          {t('message.voice', { duration: formatVoiceDuration(durationMs) })}
        </span>
        <span
          style={{
            fontSize: 'var(--font-caption)',
            opacity: 0.72,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '160px',
          }}
        >
          {fileName}
        </span>
        <span
          style={{
            fontSize: 'var(--font-caption)',
            opacity: 0.82,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            overflow: 'hidden',
            maxWidth: '160px',
          }}
        >
          {transcript}
        </span>
      </div>
    </div>
  )
}
