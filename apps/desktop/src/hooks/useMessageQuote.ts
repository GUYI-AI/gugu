import { useCallback, useLayoutEffect, useRef, type SetStateAction } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { composerCardLine } from '../lib/composerCardCopy'
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import type { ChatMessageComposerProps } from '../components/chat/chatComposerModels'
import type { QuoteSelection } from '../components/chat/messageQuoteContent'
import { useChatStore } from '../store/chatContext'

type Quote = NonNullable<ChatMessageComposerProps['quoteContent']>

/** Every conversation surface preserves the same selection intent, source and cancellation token. */
export function useMessageQuote(chatId: string | null, senderNameOf: (id: string | null) => string, attachmentLabel: string,
  previewTextOf?: (message: MessageItem) => string) {
  const { draftQuotes, setDraftQuote } = useChatStore('draftQuotes', 'setDraftQuote')
  const quote = chatId ? draftQuotes[chatId] ?? null : null
  const previous = useRef({ chatId, quote })
  useLayoutEffect(() => {
    const old = previous.current
    previous.current = { chatId, quote }
    if (old.chatId && old.chatId !== chatId) setDraftQuote(old.chatId, current => current === old.quote ? null : current)
  }, [chatId, quote, setDraftQuote])
  const latest = useRef({ senderNameOf, attachmentLabel, previewTextOf })
  latest.current = { senderNameOf, attachmentLabel, previewTextOf }
  const setQuote = useCallback((next: SetStateAction<Quote | null | undefined>) => {
    if (chatId) setDraftQuote(chatId, next)
  }, [chatId, setDraftQuote])
  const onQuote = useCallback((msg: MessageItem, selection?: QuoteSelection) => {
    setQuote(() => {
      const textSelection = msg.content_type === 'text' ? selection : undefined
      // An attachment quotes its file (the preview draws an image's thumbnail), never a bare label.
      const attachment = msg.content_type === 'attachment' && !parseVoiceAttachmentContent(msg.content) ? parseAttachmentContent(msg.content, msg) ?? undefined : undefined
      return {
        messageId: msg.id, source: msg, senderName: latest.current.senderNameOf(msg.sender_user_id), attachment,
        // Only an explicit text selection is an excerpt. Attachment/card labels are presentation, not excerpts.
        originalContent: textSelection?.originalContent,
        content: msg.content_type === 'widget' ? parseWidgetMessage(msg.content)?.text ?? '[Widget]'
          : attachment ? attachment.fileName
          : !textSelection && latest.current.previewTextOf ? latest.current.previewTextOf(msg)
          : msg.content_type === 'attachment' ? latest.current.attachmentLabel
          : msg.content_type === 'card' ? composerCardLine(msg.content ?? '') : msg.content ?? '',
      }
    })
  }, [setQuote])
  return { quote, setQuote, onQuote }
}
