import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '@/store/chatContext'
import { useAuth } from '@/store/auth'
import { withSourceLineCandidates } from '@/lib/mention'
import { messageForUser } from '@/lib/userFacingError'
import { ChatPickSheet } from './ChatPickSheet'

type CardSheetProps = { chat: ChatItem; onClose: () => void }

/** An addressed message brings source members into a topic. Group invitations have a separate acceptance flow. */
export function TopicInviteSheet({ chat, onClose }: CardSheetProps) {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById, sendMessageToChat } = useChatStore('chats', 'identitiesById', 'sendMessageToChat')
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = chats.find((item) => item.id === chat.source_chat_id)
  const topicMembers = new Set(chat.member_user_ids)
  const eligible = withSourceLineCandidates([], source?.member_user_ids, identitiesById)
    .filter((person) => person.id !== user?.id && !topicMembers.has(person.id))
  const selected = new Set(picked.filter((id) => eligible.some((person) => person.id === id)))
  const search = query.trim().toLocaleLowerCase()
  const rows = eligible.filter((person) => person.name.toLocaleLowerCase().includes(search)).map((person) => ({
    id: person.id,
    name: person.name,
    avatar: { name: person.name, seed: person.id, avatarUrl: identitiesById[person.id]?.avatar, isAgent: person.type === 'agent' },
  }))
  const invite = async () => {
    if (sending || !selected.size) return
    setSending(true)
    setError(null)
    try {
      const id = await sendMessageToChat(chat.id, t('topic.invitationText'), { toUserIds: [...selected] })
      if (!id) throw new Error(t('outbox.sendFailed'))
      onClose()
    } catch (cause) {
      setError(messageForUser(cause))
    } finally {
      setSending(false)
    }
  }
  const loaded = !!source?.member_user_ids && !!chat.member_user_ids
  return <ChatPickSheet title={t('topic.inviteTitle')} testId="topic-invite-picker" onClose={() => { if (!sending) onClose() }}
    rows={rows} selected={selected} onToggle={(id) => setPicked((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])}
    query={query} onQuery={setQuery} placeholder={t('group.memberList.search')}
    empty={!loaded ? t('common.loading') : query ? t('group.memberList.noMatches', { query }) : t('topic.noInviteCandidates')}
    actionLabel={t('topic.sendInvitation')} actionDisabled={!loaded || sending || !selected.size} onAction={() => void invite()} error={error} />
}
