import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings } from '@gugu/core/shared/types/chat'
import { groupInviteAccess } from '../../lib/groupMemberPermissions'
import { openPanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { folderItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { useChatStore } from '../../store/chatContext'
import { Avatar } from '../Avatar'
import { useChatFolderName } from './chatFolderName'
import { GroupAddMenu } from './GroupAddMenu'
import { SettingsNavRow } from './groupSettingsUi'

// 群信息主页上的两行:群成员(头像、「+」、人数)和这个群的文件夹。从 GroupMembersSection 拆出来,各自只做一件事。

const memberStackStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', marginRight: 8 }
const memberStackItemStyle: CSSProperties = { display: 'inline-flex', marginLeft: -6, borderRadius: 'var(--radius-circle)' }
const inviteSlotStyle: CSSProperties = { display: 'inline-flex', marginRight: 8 }
const MEMBER_PREVIEW_COUNT = 5

/**
 * 群成员那一行:点这一行进成员页;头像后面的「+」是群的那一个添加菜单(GroupAddMenu,同成员页标题、内栏头一行),
 * 选人页开在这一页上面,关了还在这一页。「+」在这一行里面,所以它(连同传送出去的菜单、选人页)的点击和按键不往上冒。
 */
export function GroupMembersRow({ chatId, settings, memberIds, total, onOpen }: {
  chatId: string
  settings: GroupChatSettings | null
  memberIds: readonly string[]
  total: number
  onOpen: () => void
}) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const contain = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()
  return (
    <SettingsNavRow
      title={t('group.settings.members')}
      testId="group-settings-members"
      onClick={onOpen}
      value={(
        <>
          <span style={memberStackStyle}>
            {memberIds.slice(0, MEMBER_PREVIEW_COUNT).map((id) => (
              <span key={id} style={memberStackItemStyle}>
                <Avatar name={identitiesById[id]?.display_name ?? ''} avatarUrl={identitiesById[id]?.avatar ?? null} seed={id} size={24} />
              </span>
            ))}
          </span>
          <span style={inviteSlotStyle} onClick={contain} onKeyDown={contain}>
            <GroupAddMenu chatId={chatId} canAddMembers={groupInviteAccess(chatId, 'group', settings).showInvite} size="sm" />
          </span>
          {total}
        </>
      )}
    />
  )
}

/** 文件夹那一行:页头「…」里「文件」那一项的同一个动作(开这个群的文件夹页签),名字也是同一个(useChatFolderName)。 */
export function GroupFolderRow({ chatId }: { chatId: string }) {
  return <SettingsNavRow title={useChatFolderName()} testId="group-settings-folder" onClick={() => openPanelItem(chatId, folderItem())} />
}
