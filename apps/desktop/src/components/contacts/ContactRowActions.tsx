import { useRef, useState } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Trash } from '@/lib/icons'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Menu } from '../ui/Menu'
import { MenuTableItems } from '../MenuTableItems'
import { AliasSheet } from './AliasSheet'
import { useContactsStore } from '../../store/contactsContext'
import { useChatStore } from '../../store/chatContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { sessionMenu } from '../../session/shared/session-menu'
import { chatsInReadScope, conversationMenu, hasUnreadInRows } from '../../session/shared/conversation-row-menu'

// #3253 通讯录行的动作面：右键菜单（#886 起）+ hover 浮出的删除钮。
// 从 ContactsPanel 抽出，一是那个 god 文件行数被 CI 冻结，二是这两条路径本就是同一件事的两个入口。

// #886 联系人行右键菜单的入参。人、群、我的 agent 三种行共用:动作表不在这里 —— 人和群取会话那张
// (conversation-row-menu.ts),我的 agent 取会话(任务)那张(session-menu.ts),入口 `contacts`。
export interface ContactRowMenuActions {
  removeLabel: string
  /** A person (alias, remove contact) or my agent (rename, archive). Group rows pass `group` instead. */
  contact?: ContactUser
  /** A group row: its chat, my role in it (owner dissolves, a member leaves) and its name for the confirmation. */
  group?: { chatId: string; role?: string | null; name?: string | null }
  onStartChat?: () => void
  isPinned: boolean
  notifMuted: boolean
  onPin: () => void
  onMarkUnread?: () => void
  onToggleNotif: () => void
  /** Leave / dissolve a group, delete a contact, archive my agent: each handler asks its confirmation itself. */
  onRemove: () => void
}

// #886 通讯录右键菜单:与聊天列表同一种 <Menu> 原语、同一张动作表。
export function ContactRowContextMenu({
  x,
  y,
  onClose,
  contact,
  group,
  onStartChat,
  isPinned,
  notifMuted,
  onPin,
  onMarkUnread,
  onToggleNotif,
  onRemove,
}: ContactRowMenuActions & { x: number; y: number; onClose: () => void }) {
  const { updateContactAlias, updateAgentProfile } = useContactsStore()
  const { chats, markUnread } = useChatStore('chats', 'markUnread')
  const markRead = useMarkChatsRead()
  const [aliasOpen, setAliasOpen] = useState(false)
  // Base UI 选中菜单项后会回调 onOpenChange(false) → 宿主清 menuPos → 本组件整个卸载,弹窗还没挂就没了。
  // 所以「设置备注」这一下要吞掉 Menu 的关闭请求,改由弹窗的 onClose 收尾。
  const aliasOpening = useRef(false)
  const agent = contact?.type === 'agent' ? contact : undefined
  const person = contact && !agent ? contact : undefined
  const chat = group ? chats.find((row) => row.id === group.chatId) : chats.find((row) => row.kind === 'dm' && row.peer_user_id === contact?.id)
  const hasUnread = chat ? hasUnreadInRows(chatsInReadScope(chats, chat.id)) : false
  if (aliasOpen && person) return <AliasSheet name={person.display_name} alias={person.alias} avatarUrl={person.avatar} seed={person.id} onSave={(alias) => updateContactAlias(person.id, alias)} onClose={onClose} />
  const common: Record<string, () => void> = {
    ...(onStartChat ? { 'open-chat': onStartChat } : {}),
    ...(chat ? { 'mark-read': () => markRead(chat.id) } : {}),
    ...(onMarkUnread ? { 'mark-unread': onMarkUnread } : chat ? { 'mark-unread': () => void markUnread(chat.id) } : {}),
    pin: onPin,
    notifications: onToggleNotif,
  }
  const run: Record<string, () => void> = agent
    ? { ...common, rename: () => showModal('renameSessionModal', { sessionId: '', currentTitle: agent.display_name, rename: (name) => updateAgentProfile(agent.id, { name }) }), archive: onRemove }
    : { ...common, 'set-alias': () => { aliasOpening.current = true; setAliasOpen(true) }, 'leave-group': onRemove, 'remove-contact': onRemove }
  const items = agent
    ? sessionMenu('contacts', { pinned: isPinned, sidebarPin: null, hasUnread, notificationsMuted: notifMuted }, keysOf(run))
    : conversationMenu(group ? 'contacts-group' : 'contacts', {
        kind: group ? 'group' : 'dm', hasUnread, pinned: isPinned, notificationsMuted: notifMuted, friend: person !== undefined,
        canLeave: group !== undefined && group.role !== 'owner',
      }, keysOf(run))
  return (
    <Menu x={x} y={y} minWidth={160} onClose={() => { if (!aliasOpening.current) onClose() }}>
      <MenuTableItems<string> items={items} testIdPrefix="contact-row" onAction={(id) => { if (id !== 'set-alias') onClose(); run[id]!() }} />
    </Menu>
  )
}

/** The actions a handler map can run, as the tables take them. */
function keysOf<A extends string>(run: Record<string, () => void>): ReadonlySet<A> {
  return new Set(Object.keys(run) as A[])
}

// #3253 hover 浮出的删除钮。为什么是行的 DOM **同级**而不是嵌在行里：行本身是 <button>，
// 按钮不能嵌按钮（HTML 非法，焦点行为也坏）。代价是指针移到钮上时行自身的 :hover 会假掉，
// 由 tokens.css 的 .gg-row-host:hover 接管行底色补上。
// 只让 opacity 参与过渡：会话页那条 hover 动作钮的注释记着，位移一起过渡会让刚 hover 的
// 100ms 内点击落空（`sidebar-session-item.tsx`），这里直接不做位移。
export function ContactRowDeleteButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={AUTOMATION_TEST_IDS.contactRowRemove}
      className="gg-ghost absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center opacity-0 transition-opacity duration-[var(--dur-fast)] [transition-timing-function:var(--ease)] hover:text-[var(--danger-fg)] focus-visible:opacity-100 group-hover/contact-row:opacity-100"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onRemove()
      }}
    >
      <Trash size={15} />
    </button>
  )
}
