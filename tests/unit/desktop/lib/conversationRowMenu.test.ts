import { describe, expect, it } from 'vitest'
import { CONVERSATION_MENU_EXCLUDES, chatsInReadScope, conversationMenu, hasUnreadInRows, personalConversationMenu, type ConversationMenuEntry, type ConversationRowAction, type ConversationRowMenuState } from '../../../../apps/desktop/src/session/shared/conversation-row-menu'
import { SHORT_MENU, menuLayout } from '../../../../apps/desktop/src/session/shared/menu-table'

const ALL: ConversationRowAction[] = ['open-chat', 'set-alias', 'mark-read', 'mark-unread', 'pin', 'notifications', 'mark-topics-read', 'leave-group', 'remove-contact', 'remove-project']
const handledBy = (entry: ConversationMenuEntry) => new Set(ALL.filter((id) => CONVERSATION_MENU_EXCLUDES[entry][id] === undefined))
const conversationRowMenu = (state: ConversationRowMenuState, entry: ConversationMenuEntry = 'contacts-group') => conversationMenu(entry, state, handledBy(entry))
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

describe('conversation row actions', () => {
  // owner 11-20: an Agent's DM has no clear history; my active Agent's has its archive (the session table's label).
  it('a chat-list row: a person or group clears history, an Agent does not, my active Agent archives', () => {
    const row = (state: Partial<Parameters<typeof personalConversationMenu>[0]>) => ids(personalConversationMenu({ canDelete: true, hasUnread: true, ...state }))
    expect(row({})).toEqual(['pin', 'mark-read', 'notifications', 'hide-chat', 'delete-chat'])
    expect(row({ agent: true })).toEqual(['pin', 'mark-read', 'notifications', 'hide-chat'])
    expect(row({ agent: true, canArchive: true })).toEqual(['pin', 'mark-read', 'notifications', 'hide-chat', 'archive'])
    expect(personalConversationMenu({ canDelete: true, hasUnread: false, agent: true, canArchive: true }).find((item) => item.id === 'archive')?.label).toEqual({ ns: 'session', key: 'task.archiveTaskTitle' })
  })

  it('only offers the Agent name action for an editable owned Agent', () => {
    const state = { canDelete: true, hasUnread: false, agent: true }
    expect(ids(personalConversationMenu(state))).not.toContain('rename-agent')
    expect(personalConversationMenu({ ...state, canRenameAgent: true })).toContainEqual({
      id: 'rename-agent', label: { ns: 'contacts', key: 'agentName.editAction' }, icon: 'rename',
    })
  })

  // Rule 4 of @@@menu-order: rare, irreversible and felt by every member — on the settings page, in no menu.
  it('never offers dissolving a group or deleting a topic, whoever opens the menu', () => {
    for (const kind of ['group', 'topic', 'dm'] as const) {
      for (const entry of ['contacts', 'contacts-group', 'topic-popup'] as const) {
        expect(ids(conversationRowMenu({ kind, hasUnread: false, canLeave: kind === 'group' }, entry)).filter((id) => /delete|dissolve/.test(id))).toEqual([])
      }
    }
  })

  it('orders a group row by frequency: read state, pin, notifications, then 更多 with leaving last', () => {
    expect(ids(conversationRowMenu({ kind: 'group', canLeave: true, hasUnread: true }))).toEqual(['mark-read', 'pin', 'notifications', 'leave-group'])
    expect(ids(conversationRowMenu({ kind: 'group', canLeave: false, hasUnread: false }))).toEqual(['mark-unread', 'pin', 'notifications'])
  })

  it('puts the same scoped read action first, followed only by the row type’s own actions', () => {
    const chat = conversationRowMenu({ kind: 'group', hasUnread: true })
    const project = conversationRowMenu({ kind: 'project', hasUnread: true }, 'project-row')
    expect(chat[0]).toEqual(project[0])
    expect(ids(project)).toEqual(['mark-read', 'remove-project'])
    const topic = conversationRowMenu({ kind: 'topic', hasUnread: false, hasTopicsUnread: true }, 'topic-popup')
    expect(topic.map((item) => [item.id, item.disabled])).toEqual([['mark-topics-read', false]])
  })

  it('names the read row by the read state: mark read while unread, mark unread otherwise', () => {
    expect(conversationRowMenu({ kind: 'dm', hasUnread: true })[0]?.id).toBe('mark-read')
    expect(conversationRowMenu({ kind: 'dm', hasUnread: false })[0]?.id).toBe('mark-unread')
  })

  it('a friend\'s alias is in 更多, and removing the friend is in contacts only, last', () => {
    expect(ids(conversationRowMenu({ kind: 'dm', friend: true, hasUnread: false }, 'contacts'))).toEqual(['open-chat', 'mark-unread', 'pin', 'notifications', 'set-alias', 'remove-contact'])
  })

  it('every exclusion says why, and a missing handler throws', () => {
    for (const excludes of Object.values(CONVERSATION_MENU_EXCLUDES)) for (const reason of Object.values(excludes)) expect(reason?.trim()).toBeTruthy()
    expect(() => conversationMenu('contacts', { kind: 'dm', hasUnread: false }, new Set(['open-chat']))).toThrow(/'mark-unread'/)
  })

  it('names pin and notifications by their current state', () => {
    const menu = conversationRowMenu({ kind: 'group', hasUnread: false, pinned: true, notificationsMuted: true })
    expect(menu.find((item) => item.id === 'pin')?.label.key).toBe('chatList.unpin')
    expect(menu.find((item) => item.id === 'notifications')?.label.key).toBe('chatList.enableNotifications')
  })
})

describe('menu layout (@@@menu-order)', () => {
  const row = (id: string, extra: { fold?: true; danger?: true } = {}) => ({ id, ...extra })
  it('keeps a short menu flat, destructive rows last', () => {
    const items = [row('a'), row('x', { danger: true, fold: true }), row('b', { fold: true })]
    expect(items.length).toBeLessThanOrEqual(SHORT_MENU)
    const { top, more } = menuLayout(items)
    expect([ids(top), ids(more)]).toEqual([['a', 'b', 'x'], []])
  })
  it('folds a long menu: top level first, then 更多 with destructive rows last', () => {
    const { top, more } = menuLayout([row('a'), row('d', { danger: true, fold: true }), row('b'), row('f1', { fold: true }), row('c'), row('f2', { fold: true })])
    expect([ids(top), ids(more)]).toEqual([['a', 'b', 'c'], ['f1', 'f2', 'd']])
  })
  it('a destructive row is never at the top level of a folded menu', () => {
    const { top, more } = menuLayout([row('a'), row('b'), row('c'), row('d'), row('x', { danger: true })])
    expect([ids(top), ids(more)]).toEqual([['a', 'b', 'c', 'd'], ['x']])
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
