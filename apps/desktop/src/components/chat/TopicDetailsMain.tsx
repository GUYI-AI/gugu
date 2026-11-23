import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { ChevronLeft, LogOut } from '@/lib/icons'
import { chatService } from '@/lib/chat'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { useChatStore } from '@/store/chatContext'
import { useRoomCollab } from '../../hooks/useRoomCollab'
import { DetailsGroupTitle, DetailsHero, DetailsPage, DetailsRow } from '../details/DetailsParts'
import { Button } from '../ui/Button'
import { ChatDetailsQuickActions } from './ChatDetailsQuickActions'
import { ChatManagementActions } from './ChatManagementActions'
import { GroupMembersBlock } from './GroupInfoRows'
import { GroupNameInlineEdit } from './GroupNameInlineEdit'
import { groupRoleRevision, useGroupChatSettings } from './useGroupChatSettings'
import { TopicMark } from './TopicMark'

/**
 * 话题(第 16 版:点话题 = 换主会话)的「详情」:圆底消息图标 + 话题名(能改的人点了改)+「来自群「…」」;话题成员块(进话题成员页);
 * 搜索聊天记录 / 文件 / 应用 / 回到群;「聊天」一组;红色「退出话题」—— 和话题成员页里把自己移出是同一个动作(只是不再收通知,
 * 来源群里照样看得见,所以 ❌ 从本地列表抹掉),没有群公告那一组。
 */
export function TopicDetailsMain({ chat, currentUserId, membersPage, onClose, onClearMessages, onSetNotificationLevel, onTogglePinned }: {
  chat: ChatItem
  /** The topic's member list (the panel's TopicMembers), shown under a 「‹ 详情」 back row. */
  membersPage: (back: () => void) => ReactNode
  currentUserId: string | null
  onClose: () => void
  onClearMessages: () => Promise<void>
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const sourceChatId = chat.source_chat_id ?? null
  const { chats } = useChatStore('chats')
  const source = sourceChatId ? chats.find((row) => row.id === sourceChatId) : undefined
  const { snapshot, authorityRevision } = useRoomCollab(chat.id, 'topic', sourceChatId)
  const { settings, update } = useGroupChatSettings(chat.id, snapshot ? groupRoleRevision(snapshot) : undefined, authorityRevision)
  const [page, setPage] = useState<'main' | 'members'>('main')
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = chat.name || t('topic.untitled')
  const memberIds = snapshot ? [...snapshot.humans.map((member) => member.id), ...snapshot.agents.map((member) => member.id)] : []
  const total = snapshot ? snapshot.humans.length + snapshot.agents.length : null

  if (page === 'members') return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" data-testid="topic-details-back" onClick={() => setPage('main')}
        className="flex h-10 shrink-0 items-center gap-1 px-4 text-[13px] text-[var(--muted-fg)] hover:text-[var(--fg)]">
        <ChevronLeft className="size-4" />{t('conversationCard.details')}
      </button>
      {membersPage(() => setPage('main'))}
    </div>
  )

  const leave = async () => {
    if (!currentUserId || leaving) return
    setLeaving(true)
    setError(null)
    try {
      await chatService.removeGroupMember(chat.id, currentUserId)
      setConfirmLeave(false)
    } catch (err) {
      rendererLogger('chat/topic-details').error({ error: err, chatId: chat.id }, 'leave topic failed')
      setError(messageForUser(err))
    } finally {
      setLeaving(false)
    }
  }

  return (
    <DetailsPage testId="topic-details">
      <DetailsHero
        avatar={<TopicMark size={64} glyph={30} />}
        name={<GroupNameInlineEdit hero name={name} canEdit={settings?.can_manage === true}
          labels={{ editHint: t('group.editName'), placeholder: t('topic.untitled') }}
          onCommit={async (next) => { if (!(await update({ name: next }))) throw new Error('topic rename failed') }} />}
        sub={source ? t('groupDetails.topicSource', { name: chatDisplayName(source, null) }) : null}
      />
      <GroupMembersBlock topic chatId={chat.id} settings={settings} memberIds={memberIds} total={total} people={null} agents={null} onOpen={() => setPage('members')} />
      <ChatDetailsQuickActions chatId={chat.id} isGroup={false} sourceChatId={sourceChatId ?? undefined} />
      <DetailsGroupTitle>{t('group.settings.sectionChat')}</DetailsGroupTitle>
      <ChatManagementActions activeChat={chat} appearance="details" onClose={onClose} onClearMessages={onClearMessages}
        onSetNotificationLevel={onSetNotificationLevel} onTogglePinned={onTogglePinned} />
      {confirmLeave ? (
        <div className="mt-2 px-1">
          <p className="mb-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">{t('topic.leaveHint')}</p>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" disabled={leaving} className="flex-1" onClick={() => { void leave() }}>{t('topic.leave')}</Button>
            <Button variant="secondary" size="sm" disabled={leaving} className="flex-1" onClick={() => setConfirmLeave(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : currentUserId ? <DetailsRow icon={<LogOut />} label={t('topic.leave')} testId="topic-details-leave" danger onClick={() => setConfirmLeave(true)} /> : null}
      {error ? <div role="alert" className="px-1 pt-2 text-[length:var(--font-caption)] text-[var(--danger-fg)]">{error}</div> : null}
    </DetailsPage>
  )
}
