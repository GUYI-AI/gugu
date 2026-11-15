import { describe, expect, it } from 'vitest'
import { chatsInReadScope, conversationCanDelete, conversationRowMenu, hasUnreadInRows, rowRoomCanDelete } from '../../../../apps/desktop/src/session/shared/conversation-row-menu'

describe('conversation row actions', () => {
  it('limits owned agent DM deletion to archived or removed identities', () => {
    expect(conversationCanDelete('dm', null, { session_archived_at: null, removed_at: null })).toBe(false)
    expect(conversationCanDelete('dm', null, {})).toBe(false)
    expect(conversationCanDelete('dm', null, { session_archived_at: '2026-11-06T10:00:00Z' })).toBe(true)
    expect(conversationCanDelete('dm', null, { removed_at: '2026-11-06T10:00:00Z' })).toBe(true)
  })
  it('keeps distinct server authority for groups and topics', () => {
    expect(conversationCanDelete('dm', { can_dissolve: true })).toBe(false)
    expect(conversationCanDelete('ai', { can_dissolve: true }, { removed_at: '2026-11-06T10:00:00Z' })).toBe(false)
    expect(conversationCanDelete('group', null)).toBe(false)
    expect(conversationCanDelete('group', { can_archive_topic: true })).toBe(false)
    expect(conversationCanDelete('group', { can_dissolve: true })).toBe(true)
    expect(conversationCanDelete('topic', { can_dissolve: true })).toBe(false)
    expect(conversationCanDelete('topic', { can_archive_topic: true })).toBe(true)
  })
  // CH5: the delete item used to appear after the room's authority was read; unknown now keeps its place, disabled.
  it('keeps the delete item in place, disabled, while the authority to delete is not read', () => {
    const menu = conversationRowMenu({ kind: 'chat', canDelete: 'unknown', hasUnread: false, hasAnyUnread: false })
    expect(menu.map((item) => item.id)).toEqual(['mark-read', 'pin', 'notifications', 'mark-all-read', 'delete-chat'])
    expect(menu.at(-1)).toMatchObject({ id: 'delete-chat', disabled: true })
    expect(conversationRowMenu({ kind: 'chat', canDelete: true, hasUnread: false }).at(-1)).toMatchObject({ id: 'delete-chat', disabled: false })
  })
  // CH5 for a member: the menu took the owner's shape until the authority was read, then lost 更多. The rows' roles say it.
  it('reads the authority to delete a room from the rows, as group_info_as derives it', () => {
    const none = () => undefined
    expect(rowRoomCanDelete({ kind: 'group', my_role: 'owner' }, none)).toBe(true)
    expect(rowRoomCanDelete({ kind: 'group', my_role: 'admin' }, none)).toBe(false)
    expect(rowRoomCanDelete({ kind: 'group', my_role: 'member' }, none)).toBe(false)
    expect(rowRoomCanDelete({ kind: 'group' }, none)).toBeUndefined()
    const group = (my_role: string, status = 'active') => () => ({ kind: 'group', my_role, status })
    expect(rowRoomCanDelete({ kind: 'topic', source_chat_id: 'g' }, group('admin'))).toBe(true)
    expect(rowRoomCanDelete({ kind: 'topic', source_chat_id: 'g' }, group('member'))).toBe(false)
    expect(rowRoomCanDelete({ kind: 'topic', source_chat_id: 'g' }, group('owner', 'archived'))).toBe(false)
    // A topic of a private conversation goes by its creator: the rows do not say.
    expect(rowRoomCanDelete({ kind: 'topic', source_chat_id: 'd' }, () => ({ kind: 'dm' }))).toBeUndefined()
  })
  it('puts the same scoped read action first, followed only by the row type’s own actions', () => {
    const chat = conversationRowMenu({ kind: 'chat', canDelete: true, hasUnread: true, hasAnyUnread: true })
    const project = conversationRowMenu({ kind: 'project', hasUnread: true })
    expect(chat[0]).toEqual(project[0])
    expect(chat.map((item) => item.id)).toEqual(['mark-read', 'pin', 'notifications', 'mark-all-read', 'delete-chat'])
    expect(project.map((item) => item.id)).toEqual(['mark-read', 'remove-project'])
    const topic = conversationRowMenu({ kind: 'topic', hasUnread: false, hasAnyUnread: true })
    expect(topic.map((item) => [item.id, item.disabled])).toEqual([['mark-read', true], ['mark-all-read', false]])
  })

  it('keeps personal actions when the server denies topic management', () => {
    const items = conversationRowMenu({ kind: 'chat', canDelete: false, hasUnread: true, hasAnyUnread: true })
    expect(items.map((item) => item.id)).toEqual(['mark-read', 'pin', 'notifications', 'mark-all-read'])
  })

  it('keeps scoped availability independent from unread conversations elsewhere', () => {
    const menu = conversationRowMenu({ kind: 'chat', canDelete: true, hasUnread: false, hasAnyUnread: true, pinned: true, notificationsMuted: true })
    expect(menu.find((item) => item.id === 'mark-read')?.disabled).toBe(true)
    expect(menu.find((item) => item.id === 'mark-all-read')?.disabled).toBe(false)
    expect(menu.find((item) => item.id === 'pin')?.label).toBe('unpin')
    expect(menu.find((item) => item.id === 'notifications')?.label).toBe('enableNotifications')
  })

  it('offers 取消固定到左侧栏 right after 置顶 only for a row pinned to the sidebar (#2548)', () => {
    const pinned = conversationRowMenu({ kind: 'chat', canDelete: false, hasUnread: false, pinnedToSidebar: true })
    expect(pinned.map((item) => item.id)).toEqual(['mark-read', 'pin', 'unpin-from-sidebar', 'notifications', 'mark-all-read'])
    expect(pinned.find((item) => item.id === 'unpin-from-sidebar')).toMatchObject({ label: 'unpinFromSidebar', icon: 'sidebar' })
    expect(conversationRowMenu({ kind: 'chat', canDelete: false, hasUnread: false }).some((item) => item.id === 'unpin-from-sidebar')).toBe(false)
  })
})

describe('the selected conversation and its topics', () => {
  const rows = [
    { id: 'nested', kind: 'topic', source_chat_id: 'topic', unread_count: 2 },
    { id: 'outside-topic', kind: 'topic', source_chat_id: 'outside', unread_count: 4 },
    { id: 'root', kind: 'group', unread_count: 0 },
    { id: 'topic', kind: 'topic', source_chat_id: 'root', unread_count: 3 },
    { id: 'outside', kind: 'dm', unread_count: 1 },
  ]
  it('includes unread topic descendants even when the selected main line is already read', () => {
    const scope = chatsInReadScope(rows, 'root')
    expect(scope.map((row) => row.id)).toEqual(['nested', 'root', 'topic'])
    expect(hasUnreadInRows(scope)).toBe(true)
    expect(chatsInReadScope(rows, 'outside').map((row) => row.id)).toEqual(['outside-topic', 'outside'])
  })
  it('does not mark a topic’s parent or siblings, and includes a durable manual unread mark', () => {
    expect(chatsInReadScope(rows, 'topic').map((row) => row.id)).toEqual(['nested', 'topic'])
    expect(chatsInReadScope(rows, ['topic', 'outside-topic']).map((row) => row.id)).toEqual(['nested', 'outside-topic', 'topic'])
    expect(hasUnreadInRows([{ unread_count: 0, is_marked_unread: true }])).toBe(true)
  })
})
