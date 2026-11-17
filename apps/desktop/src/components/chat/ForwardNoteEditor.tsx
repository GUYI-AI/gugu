import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ForwardNote } from './forwardToChats'
import { NoteEditor } from './NoteEditor'
import { useChatNote } from './useGroupMentionProvider'

/**
 * A forward's note: the group composer's editor and @, over the members of the chat being forwarded into. @ needs one
 * chat (a name means a different member in each), so with several picked the note offers no one.
 */
export function ForwardNoteEditor({ chat, onChange }: {
  /** The one chat picked; null with several. */
  chat: ChatItem | null
  onChange: (note: ForwardNote) => void
}) {
  const { t } = useTranslation('messaging')
  const [text, setText] = useState('')
  const { mentionProvider, renderMentionIcon, onMentionInsert, addressed } = useChatNote(chat)
  useEffect(() => { onChange({ text, toUserIds: addressed(text) }) }, [text, addressed, onChange])
  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--border-strong)] px-[10px] py-[7px] text-[length:var(--font-body)]" data-forward-note="">
      <NoteEditor inputTestId="forward-note" placeholder={t('forward.note')}
        onChange={setText} onMentionInsert={onMentionInsert} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} />
    </div>
  )
}
