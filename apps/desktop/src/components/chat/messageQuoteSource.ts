import { createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import { systemNoticeText } from '@/lib/systemNoticeText'

/** Only the messages already loaded in this list; looking up a quote never requests history. */
export const MessageQuoteSourceContext = createContext<ReadonlyMap<string, MessageItem>>(new Map())

export function useQuotedSystemNoticeText(message: MessageItem): string | null {
  useTranslation('messaging')
  const sources = useContext(MessageQuoteSourceContext)
  const source = message.reply_to_message_id ? sources.get(message.reply_to_message_id) : undefined
  const notice = source && source.chat_id === message.chat_id ? parseSystemNotice(source) : null
  return notice?.kind === 'migration-placeholder' ? systemNoticeText(notice, '') : null
}
