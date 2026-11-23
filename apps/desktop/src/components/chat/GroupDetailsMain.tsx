import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, GroupChatSettings, NotificationLevel } from '@gugu/core/shared/types/chat'
import { BookOpen, FileText, Info, LogOut, Shield } from '@/lib/icons'
import { Avatar } from '../Avatar'
import { DetailsGroupTitle, DetailsHero, DetailsList, DetailsPage, DetailsRow } from '../details/DetailsParts'
import { Button } from '../ui/Button'
import { useReplica } from '../../lib/replica'
import { groupAnnouncements } from '../../lib/groupAnnouncements'
import { ChatDetailsQuickActions } from './ChatDetailsQuickActions'
import { ChatManagementActions } from './ChatManagementActions'
import { GroupAvatarEditor } from './GroupAvatarEditor'
import { GroupMembersBlock } from './GroupInfoRows'
import { GroupNameRow } from './GroupNameRow'

export interface GroupDetailsMainProps {
  chat: ChatItem
  name: string | null
  settings: GroupChatSettings | null
  manager: boolean
  memberIds: readonly string[]
  total: number | null
  /** People and agents in it (the roster); null until it is read. */
  people: number | null
  agents: number | null
  avatar: { uploading: boolean; onFile: (file: File | undefined) => Promise<void>; onReset: () => Promise<void> }
  onRename: (name: string) => Promise<void>
  onOpenPage: (page: 'members' | 'announcement' | 'manage') => void
  onOpenText: (page: 'rules' | 'description') => void
  onClose: () => void
  onClearMessages: () => Promise<void>
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  /** null: this viewer can neither leave nor dissolve it. */
  exit: { owner: boolean; busy: boolean; confirming: boolean; setConfirming: (on: boolean) => void; run: () => void } | null
  errorLine: ReactNode
}

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split('\n').find((part) => part.trim())
  return line?.trim() || null
}

/**
 * 群的「详情」首页,照第 16 版设计稿:群头像(管理员点了换、拖图片换)+ 群名(点了改)+ 设置备注;群成员块;四格快捷操作;
 * 公告 / 协作规则 / 群描述 / 群管理;「聊天」一组(通知三档、置顶、清空);最后红色的退出 / 解散。每一项都是原来那一页的同一个
 * 动作(GroupMembersSection 把它们交进来),这里只管画法。手机的群信息页照旧。
 */
export function GroupDetailsMain(props: GroupDetailsMainProps) {
  const { chat, name, settings, manager, memberIds, total, avatar, exit } = props
  const { t } = useTranslation('messaging')
  const [editingAvatar, setEditingAvatar] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const shownName = name ?? t('group.settings.groupFallback')
  // 公告行的预览(设计稿):置顶的、否则最新的那一条的第一行(同公告页那份读数,排序是服务端给的:置顶在前、新的在前)。
  const announcements = useReplica(groupAnnouncements, [chat.id])
  const latestAnnouncement = announcements.state === 'value' ? firstLine(announcements.value[0]?.content) : null
  return (
    <DetailsPage testId="group-details">
      <DetailsHero
        avatar={(
          <div data-testid="group-avatar" title={manager ? t('group.settings.changeAvatar') : undefined}
            onClick={manager && !avatar.uploading ? () => setEditingAvatar(true) : undefined}
            onDragOver={manager ? (event) => { event.preventDefault(); setDragOver(true) } : undefined}
            onDragLeave={manager ? () => setDragOver(false) : undefined}
            onDrop={manager ? (event) => { event.preventDefault(); setDragOver(false); void avatar.onFile(event.dataTransfer.files?.[0]) } : undefined}
            className={`relative grid size-16 place-items-center overflow-hidden rounded-full${manager && !avatar.uploading ? ' cursor-pointer' : ''}${dragOver ? ' outline-1 outline-dashed outline-[var(--primary)]' : ''}`}>
            <Avatar variant="group" name={shownName} avatarUrl={settings?.avatar_url ?? null} seed={chat.id} size={64} />
            {avatar.uploading ? <div className="absolute inset-0 grid place-items-center bg-[var(--bg-overlay-modal)] text-[length:var(--font-caption)] text-[var(--color-white)]">{t('group.settings.uploading')}</div> : null}
          </div>
        )}
        name={<GroupNameRow hero chat={chat} name={name} canEdit={manager && Boolean(settings)} onCommit={props.onRename} />}
      />
      {editingAvatar ? <GroupAvatarEditor chatId={chat.id} groupName={name ?? ''} avatarUrl={settings?.avatar_url ?? null} busy={avatar.uploading}
        onFile={(file) => avatar.onFile(file)} onReset={avatar.onReset} onClose={() => setEditingAvatar(false)} /> : null}
      <GroupMembersBlock chatId={chat.id} settings={settings} memberIds={memberIds} total={total} people={props.people} agents={props.agents} onOpen={() => props.onOpenPage('members')} />
      <ChatDetailsQuickActions chatId={chat.id} isGroup />
      <DetailsList>
        <DetailsRow icon={<FileText />} label={t('header.announcement')} testId="group-settings-announcement" chevron onClick={() => props.onOpenPage('announcement')}
          end={latestAnnouncement ?? undefined} />
        <DetailsRow icon={<BookOpen />} label={t('group.settings.rules')} testId="group-settings-rules" chevron onClick={() => props.onOpenText('rules')}
          end={settings ? firstLine(settings.group_prompt) ?? t('group.settings.rulesUnset') : undefined} />
        <DetailsRow icon={<Info />} label={t('group.settings.description')} testId="group-settings-description" chevron onClick={() => props.onOpenText('description')}
          end={settings ? firstLine(settings.description) ?? t('group.settings.descriptionUnset') : undefined} />
        {manager && settings ? <DetailsRow icon={<Shield />} label={t('group.settings.manage')} testId="group-settings-manage" chevron onClick={() => props.onOpenPage('manage')} /> : null}
      </DetailsList>
      <DetailsGroupTitle>{t('group.settings.sectionChat')}</DetailsGroupTitle>
      <ChatManagementActions activeChat={chat} appearance="details" onClose={props.onClose} onClearMessages={props.onClearMessages}
        onSetNotificationLevel={props.onSetNotificationLevel} onTogglePinned={props.onTogglePinned} />
      {exit ? exit.confirming ? (
        <div className="mt-2 px-1">
          <p className="mb-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">{exit.owner ? t('group.settings.dissolveConfirm') : t('group.settings.leaveConfirm')}</p>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" disabled={exit.busy} className="flex-1" onClick={exit.run}>{exit.owner ? t('group.settings.dissolve') : t('group.settings.leave')}</Button>
            <Button variant="secondary" size="sm" disabled={exit.busy} className="flex-1" onClick={() => exit.setConfirming(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : <DetailsRow icon={<LogOut />} label={exit.owner ? t('group.settings.dissolve') : t('group.settings.leave')} testId="group-settings-exit" danger onClick={() => exit.setConfirming(true)} /> : null}
      {props.errorLine}
    </DetailsPage>
  )
}
