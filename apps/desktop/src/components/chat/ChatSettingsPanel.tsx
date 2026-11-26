import { useEffect, useState } from 'react'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useChatStore } from '@/store/chatContext'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus, ChatItem, GroupCollabSnapshot, MessageItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import type { MemberProfileCardModel, MemberProfileChatTarget } from '../MemberProfileCard'
import { MemberProfileAvatarButton } from '../MemberProfileAvatarButton'
import { MemberProfilePopover, MemberProfileRoot } from '../MemberProfilePopover'
import { Popover } from '../ui/Popover'
import type { ActiveMemberProfile } from '../memberProfileModels'
import { groupRoleRevision, useGroupChatSettings, type GroupChatSettingsState } from './useGroupChatSettings'
import { GroupMembersSection } from './GroupMembersSection'
import { MemberListPanel, type MemberListPanelProps } from './MemberListPanel'
import { GroupAgentFloodSettings } from './GroupAgentFloodSettings'
import { ChatManagementActions } from './ChatManagementActions'
import { SettingsPageHead } from './groupSettingsUi'
import { settingsDangerRowStyle } from './groupSettingsStyles'
import { useCloseTopic } from './useCloseTopic'
import { ChatDetailsQuickActions } from './ChatDetailsQuickActions'
import { DetailsGroupTitle, DetailsPage } from '../details/DetailsParts'
import { TopicDetailsMain } from './TopicDetailsMain'
import { COLOR_MUTED } from './chatPresentation'
import { useRoomCollab } from '../../hooks/useRoomCollab'

// 从 ChatAreaPanel 拆出来的(那份文件行数冻结,#7199 给它加「吃一个会话 id」时腾的位置)。
// 群信息 / 会话信息(owner 10-26):成员、公告、设置合成一枚页签(chat-info),桌面在对话旁边、手机是整页。
// 页签本身就是标题和 ×:桌面上一级页不画页头,手机左上返回 = 关掉这一页。
export type ChatSettingsPanelProps = ChatRightPanelBodyProps & { mobile?: boolean }
type ChatTopicState = { topicChatId: string; name: string }

export function ChatSettingsPanel({ mobile = false, ...body }: ChatSettingsPanelProps) {
  const { activeChat, onClose } = body
  const { t } = useTranslation('messaging')
  // A topic is a main conversation of its own: its info page is its members (from its source line's roster).
  if (activeChat.kind === 'topic' && activeChat.source_chat_id) {
    const sourceChatId = activeChat.source_chat_id
    const members = (back: () => void) => <TopicMembers key={activeChat.id} topic={{ topicChatId: activeChat.id, name: activeChat.name ?? '' }} sourceChatId={sourceChatId} onClose={back} mobile={mobile} onWhisper={body.onWhisper} />
    // 第 16 版:桌面上是话题的「详情」(成员页从它的成员块进);手机照旧直接是成员页。
    if (mobile) return members(onClose)
    return <TopicDetailsMain key={activeChat.id} chat={activeChat} currentUserId={body.currentUserId} onClose={onClose}
      onClearMessages={body.onClearMessages} onSetNotificationLevel={body.onSetNotificationLevel} onTogglePinned={body.onTogglePinned} membersPage={members} />
  }
  // 桌面上私聊的「详情」和群、话题是同一张页(DetailsPage 的边距和部件);手机照旧是带页头的整页。
  if (!mobile && activeChat.kind !== 'group') return (
    <DetailsPage testId="chat-settings-panel">
      <ChatDetailsQuickActions chatId={activeChat.id} isGroup={false} />
      <ChatRightPanelBody {...body} details />
    </DetailsPage>
  )
  return (
    <div data-testid="chat-settings-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {activeChat.kind === 'group' || !mobile ? null : <SettingsPageHead title={t('chatArea.settings.conversation')} onClose={onClose} mobile />}
      <ChatRightPanelBody {...body} />
    </div>
  )
}

export function TopicMembers({ topic, sourceChatId, onClose, mobile, onWhisper }: { topic: ChatTopicState; sourceChatId: string; onClose: () => void; mobile: boolean; onWhisper?: ChatRightPanelBodyProps['onWhisper'] }) {
  const { t } = useTranslation('messaging')
  const closeTopic = useCloseTopic()
  const { snapshot, error, reload, authorityRevision } = useRoomCollab(topic.topicChatId, 'topic', sourceChatId)
  const settings = useGroupChatSettings(topic.topicChatId, snapshot ? groupRoleRevision(snapshot) : undefined, authorityRevision)
  return <div data-testid="chat-settings-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <MemberListPanel chatId={topic.topicChatId} chatKind="topic" chatName={topic.name}
      snapshot={snapshot} error={error} onReload={reload} settingsState={settings} onWhisper={onWhisper}
      head={(title, action) => <SettingsPageHead title={title} action={action} mobile={mobile} onClose={mobile ? onClose : undefined} />} />
    {settings.settings?.can_archive_topic ? <div className="px-3 pb-4"><div role="button" data-testid="topic-settings-delete" style={settingsDangerRowStyle} onClick={() => closeTopic(topic.topicChatId, topic.name, onClose)}>{t('chatList.deleteTopic')}</div></div> : null}
  </div>
}

interface ChatRightPanelBodyProps {
  activeChat: ChatItem
  /** Drawn inside the desktop 详情 page (DetailsPage): its parts and margins, ❌ the drawer's own. */
  details?: boolean
  /** Where it opens (the members' button: their list); nothing goes back past it. */
  initialPage?: 'main' | 'members' | 'announcement'
  messages: MessageItem[]
  onClose: () => void
  onClearMessages: () => Promise<void>
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  memberProfiles: MemberProfileCardModel[]
  currentUserId: string | null
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 悄悄话回调透传到内部 MemberProfilePopover。
  onWhisper?: (target: MemberProfileChatTarget) => void
  groupSettings?: GroupChatSettingsState
  groupCollabSnapshot: GroupCollabSnapshot | null
  /** Why the roster could not be read: its members' page says so. */
  groupCollabError?: MemberListPanelProps['error']
  groupAgentStatuses: Record<string, AgentDisplayStatus>
  onReloadGroupCollab: () => Promise<void>
  onLeaveGroup: () => Promise<void>
  onDissolveGroup: () => Promise<void>
}

// @@@right-panel-body - One right-side surface for DM + group + mobile. Members section differs by chat
// kind (group gets the rich role-switching list, DM keeps the simple peer card), then ChatManagementActions.
function ChatRightPanelBody({ activeChat, details = false, initialPage, onClose, onClearMessages, onSetNotificationLevel, onTogglePinned, memberProfiles, currentUserId, onOpenUserChat, onWhisper, groupSettings, groupCollabSnapshot, groupCollabError, onReloadGroupCollab, onLeaveGroup, onDissolveGroup }: ChatRightPanelBodyProps) {
  const { t } = useTranslation('messaging')
  const [profileCard] = useState(() => Popover.createHandle<ActiveMemberProfile>())
  const isGroupChat = activeChat.kind === 'group'

  useEffect(() => {
    profileCard.close()
  }, [activeChat.id, profileCard])

  const drawerProfiles = memberProfiles

  const MAX_SHOWN = 9
  const shownMembers = drawerProfiles.slice(0, MAX_SHOWN)
  const { identitiesById } = useChatStore('identitiesById')
  const names = useShownAgentName(shownMembers.map(member => ({ name: member.displayName, createdAt: member.type === 'agent' ? identitiesById[member.id]?.created_at ?? undefined : undefined })))
  const overflow = drawerProfiles.length - MAX_SHOWN

  return (
    <>
      {isGroupChat ? (
        <GroupMembersSection
          chat={activeChat}
          initialPage={initialPage}
          snapshot={groupCollabSnapshot}
          settingsState={groupSettings}
          snapshotError={groupCollabError}
          currentUserId={currentUserId}
          onReload={onReloadGroupCollab}
          onClose={onClose}
          onLeaveGroup={onLeaveGroup}
          onDissolveGroup={onDissolveGroup}
          onOpenUserChat={onOpenUserChat}
          onWhisper={onWhisper}
          onSetNotificationLevel={onSetNotificationLevel}
          onTogglePinned={onTogglePinned}
          onClearMessages={onClearMessages}
        />
      ) : (
        <>
          {details ? <DetailsGroupTitle>{t('chatArea.settings.members')}</DetailsGroupTitle>
            : <div style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', fontWeight: 'var(--font-weight-medium)', color: 'var(--muted-fg)', padding: '12px 14px 6px', userSelect: 'none' }}>{t('chatArea.settings.members')}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: details ? '0 4px 16px' : '0 14px 10px' }}>
            {shownMembers.map((m, index) => (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                <MemberProfileAvatarButton
                  member={m}
                  testId={AUTOMATION_TEST_IDS.chatDrawerProfileButton}
                  avatarSize="sm"
                  buttonSize={38}
                  profile={{ handle: profileCard, payload: { member: m, preferredSide: 'left' } }}
                />
                <span style={{ fontSize: '10px', color: COLOR_MUTED, maxWidth: '36px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {names[index]}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: 'var(--radius-document)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 'var(--font-caption)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  +{overflow}
                </div>
              </div>
            )}
          </div>
          {details ? null : <div style={{ height: '1px', background: 'var(--border-color)', flexShrink: 0, margin: '4px 0' }} />}
          <div className={details ? 'px-1' : 'px-3'}><GroupAgentFloodSettings key={activeChat.id} chatId={activeChat.id} /></div>
          {details ? <DetailsGroupTitle>{t('group.settings.sectionChat')}</DetailsGroupTitle> : null}
          <ChatManagementActions
            activeChat={activeChat}
            appearance={details ? 'details' : undefined}
            onClose={onClose}
            onClearMessages={onClearMessages}
            onSetNotificationLevel={onSetNotificationLevel}
            onTogglePinned={onTogglePinned}
          />
        </>
      )}
      <MemberProfileRoot handle={profileCard}>
        {(profile) => (
          <MemberProfilePopover
            profile={profile}
            onClose={() => profileCard.close()}
            onOpenChat={profile.member.id !== currentUserId && onOpenUserChat ? (target) => {
              profileCard.close()
              onOpenUserChat(target)
            } : undefined}
            onWhisper={onWhisper ? (target) => {
              profileCard.close()
              onWhisper(target)
            } : undefined}
            searchChatId={activeChat.id}
            testId={AUTOMATION_TEST_IDS.chatDrawerProfileMenu}
          />
        )}
      </MemberProfileRoot>
    </>
  )
}
