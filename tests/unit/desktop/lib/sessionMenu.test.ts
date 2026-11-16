import { describe, expect, it } from 'vitest'
import { SESSION_MENU_EXCLUDES, sessionMenu, type SessionMenuAction, type SessionMenuEntry, type SessionMenuState } from '../../../../apps/desktop/src/session/shared/session-menu'

const ALL: SessionMenuAction[] = ['open-chat', 'mark-read', 'mark-unread', 'pin', 'sidebar-pin', 'rename', 'notifications', 'archive', 'fork', 'copy-id', 'reload', 'legacy-history', 'mark-all-read', 'delete-chat']
const live: SessionMenuState = { pinned: false, sidebarPin: 'pin', canFork: true, hasLegacyHistory: true, hasUnread: true, hasAnyUnread: true }
/** Every action the entry does not exclude: what a correctly wired entry can run. */
const handledBy = (entry: SessionMenuEntry) => new Set(ALL.filter((id) => SESSION_MENU_EXCLUDES[entry][id] === undefined))
const ids = (entry: SessionMenuEntry, state: SessionMenuState = live) => sessionMenu(entry, state, handledBy(entry)).map((item) => item.id)

describe('one session menu table', () => {
  it('every exclusion says why', () => {
    for (const excludes of Object.values(SESSION_MENU_EXCLUDES)) for (const reason of Object.values(excludes)) expect(reason?.trim()).toBeTruthy()
  })

  it('my agent row in the chat list offers archive and rename, as its tab does (the reported cell)', () => {
    expect(ids('chat-row')).toEqual(['mark-read', 'pin', 'sidebar-pin', 'rename', 'notifications', 'archive', 'mark-all-read'])
    expect(ids('tab')).toEqual(['pin', 'sidebar-pin', 'rename', 'archive', 'fork', 'copy-id', 'reload', 'legacy-history'])
    expect(ids('sidebar-row')).toEqual(['pin', 'sidebar-pin', 'rename', 'archive', 'fork', 'copy-id'])
    expect(ids('phone')).toEqual(['pin', 'rename', 'archive'])
    // Contacts: my agent's contact row is its task too (rename, archive), plus opening its chat.
    expect(ids('contacts')).toEqual(['open-chat', 'mark-read', 'pin', 'rename', 'notifications', 'archive'])
    expect(ids('contacts', { ...live, hasUnread: false })).toEqual(['open-chat', 'mark-unread', 'pin', 'rename', 'notifications', 'archive'])
  })

  it('every entry is a subsequence of the one order, with the same label for the same action', () => {
    const order = ALL
    const labels = new Map<string, string>()
    for (const entry of Object.keys(SESSION_MENU_EXCLUDES) as SessionMenuEntry[]) {
      const items = sessionMenu(entry, live, handledBy(entry))
      const positions = items.map((item) => order.indexOf(item.id))
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
      for (const item of items) {
        const label = `${item.label.ns}:${item.label.key}`
        expect(labels.get(item.id) ?? label).toBe(label)
        labels.set(item.id, label)
      }
    }
    expect(labels.get('archive')).toBe('session:task.archiveTaskTitle')
  })

  it('an archived agent row gives way to deleting its conversation', () => {
    const archived = ids('chat-row', { ...live, archived: true, canDeleteChat: true })
    expect(archived).not.toContain('archive')
    expect(archived).toContain('delete-chat')
    expect(ids('chat-row', { ...live, archived: true, canDeleteChat: false })).not.toContain('delete-chat')
  })

  it('an entry that offers an action it cannot run fails loudly', () => {
    expect(() => sessionMenu('phone', live, new Set<SessionMenuAction>(['pin', 'rename']))).toThrow(/'archive'/)
  })

  it('names the pin by its state, and folds the low-frequency rows', () => {
    const items = sessionMenu('tab', { ...live, pinned: true }, handledBy('tab'))
    expect(items.find((item) => item.id === 'pin')?.label.key).toBe('task.unpin')
    expect(items.filter((item) => item.fold).map((item) => item.id)).toEqual(['fork', 'copy-id', 'reload', 'legacy-history'])
  })
})
