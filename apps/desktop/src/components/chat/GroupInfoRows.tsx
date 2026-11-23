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
import { Unknown } from '../ui/Unknown'
import { ChevronRight } from '@/lib/icons'

// 群信息主页上的两行:群成员(头像、「+」、人数)和这个群的文件夹。从 GroupMembersSection 拆出来,各自只做一件事。

// The faces give way on a narrow row: whole ones that do not fit wrap onto a second line this box does not show (paddingLeft
// keeps the first face's -6px overlap inside it); 「+」 and the count keep their room.
const memberStackStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', minWidth: 0, height: 24, overflow: 'hidden', paddingLeft: 6, marginRight: 8 }
const memberStackItemStyle: CSSProperties = { display: 'inline-flex', marginLeft: -6, borderRadius: 'var(--radius-circle)' }
const inviteSlotStyle: CSSProperties = { display: 'inline-flex', marginRight: 8 }
const MEMBER_PREVIEW_COUNT = 5

/**
 * 群成员那一行:点这一行进成员页;头像后面的「+」是群的那一个添加菜单(GroupAddMenu,同成员页标题),
 * 选人页开在这一页上面,关了还在这一页。「+」在这一行里面,所以它(连同传送出去的菜单、选人页)的点击和按键不往上冒。
 */
export function GroupMembersRow({ chatId, settings, memberIds, total, onOpen }: {
  chatId: string
  settings: GroupChatSettings | null
  memberIds: readonly string[]
  /** null until the roster is read. */
  total: number | null
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
          {total ?? <Unknown className="w-[2ch]" />}
        </>
      )}
    />
  )
}

/** 「N 名成员」:名册还没读到时画占位,❌ 0。 */
export function GroupMemberCount({ total, style }: { total: number | null; style: CSSProperties }) {
  const { t } = useTranslation('messaging')
  return <div style={style}>{total === null ? <Unknown className="w-20" /> : t('group.settings.memberCount', { count: total })}</div>
}

/** 文件夹那一行:页头「…」里「文件」那一项的同一个动作(开这个群的文件夹页签),名字也是同一个(useChatFolderName)。 */
export function GroupFolderRow({ chatId }: { chatId: string }) {
  return <SettingsNavRow title={useChatFolderName()} testId="group-settings-folder" onClick={() => openPanelItem(chatId, folderItem())} />
}

/**
 * 详情页(第 16 版设计稿 .memb)的群成员块:叠着的头像、「群成员」、人数、「+」(GroupAddMenu)、›;点它进成员页。
 * 和 GroupMembersRow 同一份数据、同一个「+」、同一个去处,只是画法不同。
 */
export function GroupMembersBlock({ chatId, settings, memberIds, total, people, agents, onOpen, topic = false }: Parameters<typeof GroupMembersRow>[0] & {
  /** People and agents in it; null until the roster is read (then only the total is said). */
  people: number | null; agents: number | null
  /** A topic's: 「话题成员 N 人」. */
  topic?: boolean
}) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const contain = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()
  return (
    <div role="button" tabIndex={0} data-testid="group-settings-members" onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
      className="mb-3 flex h-12 cursor-pointer items-center gap-2.5 rounded-xl bg-[var(--muted)] px-3 text-[13px]">
      <span className="flex shrink-0 ps-1.5">
        {/* 窄了先让头像:详情页(@container/details)不到 380 只留 3 个,不到 300 不留。 */}
        {memberIds.slice(0, 4).map((id, index) => (
          <span key={id} className={`-ms-1.5 flex rounded-full ring-2 ring-[var(--muted)] @max-[300px]/details:hidden ${index >= 3 ? '@max-[380px]/details:hidden' : ''}`}>
            <Avatar name={identitiesById[id]?.display_name ?? ''} avatarUrl={identitiesById[id]?.avatar ?? null} seed={id} size={22} />
          </span>
        ))}
      </span>
      <span className="shrink-0 whitespace-nowrap">{t(topic ? 'group.memberList.titleTopic' : 'group.settings.members')}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--muted-fg)]">{topic ? (total === null ? <Unknown className="w-[2ch]" /> : t('groupDetails.people', { count: total }))
        : people !== null && agents !== null ? `${t('groupDetails.people', { count: people })} · ${t('groupDetails.agents', { count: agents })}`
        : total === null ? <Unknown className="w-[2ch]" /> : t('group.settings.memberCount', { count: total })}</span>
      {/* A topic has no add entry in the product today (its member list only searches): no chip for it. */}
      {topic ? <span className="ms-auto" /> : <span className="ms-auto flex shrink-0 items-center" onClick={contain} onKeyDown={contain}>
        <GroupAddMenu chatId={chatId} canAddMembers={groupInviteAccess(chatId, 'group', settings).showInvite} labeled />
      </span>}
      <ChevronRight className="size-3.5 shrink-0 text-[var(--faint-fg)]" />
    </div>
  )
}
