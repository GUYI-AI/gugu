import { describe, expect, it } from 'vitest'
import { SESSION_MENU_EXCLUDES, sessionMenu, type SessionMenuAction, type SessionMenuEntry, type SessionMenuState } from '../../../../apps/desktop/src/session/shared/session-menu'

/** The table's one order (menu-table.ts @@@menu-order): top level by frequency, then 更多, destructive last. */
const ALL: SessionMenuAction[] = ['open-chat', 'mark-read', 'mark-unread', 'pin', 'rename', 'archive', 'sidebar-pin', 'notifications', 'fork', 'reload', 'copy-id', 'legacy-history']
const live: SessionMenuState = { pinned: false, sidebarPin: 'pin', canFork: true, hasLegacyHistory: true, hasUnread: true }
/** Every action the entry does not exclude: what a correctly wired entry can run. */
const handledBy = (entry: SessionMenuEntry) => new Set(ALL.filter((id) => SESSION_MENU_EXCLUDES[entry][id] === undefined))
const ids = (entry: SessionMenuEntry, state: SessionMenuState = live) => sessionMenu(entry, state, handledBy(entry)).map((item) => item.id)

describe('one session menu table', () => {
  it('every exclusion says why', () => {
    for (const excludes of Object.values(SESSION_MENU_EXCLUDES)) for (const reason of Object.values(excludes)) expect(reason?.trim()).toBeTruthy()
  })

  it('my agent offers archive and rename wherever it is listed', () => {
    expect(ids('tab')).toEqual(['pin', 'rename', 'archive', 'sidebar-pin', 'fork', 'reload', 'copy-id', 'legacy-history'])
    expect(ids('sidebar-row')).toEqual(['pin', 'rename', 'archive', 'sidebar-pin', 'fork', 'copy-id'])
    expect(ids('phone')).toEqual(['pin', 'rename', 'archive'])
    // Contacts: my agent's contact row is its task too (rename, archive), plus opening its chat.
    expect(ids('contacts')).toEqual(['open-chat', 'mark-read', 'pin', 'rename', 'archive', 'notifications'])
    expect(ids('contacts', { ...live, hasUnread: false })).toEqual(['open-chat', 'mark-unread', 'pin', 'rename', 'archive', 'notifications'])
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

  it('an archived agent offers no archive', () => {
    expect(ids('contacts', { ...live, archived: true })).not.toContain('archive')
  })

  it('an entry that offers an action it cannot run fails loudly', () => {
    expect(() => sessionMenu('phone', live, new Set<SessionMenuAction>(['pin', 'rename']))).toThrow(/'archive'/)
  })

  it('names the pin by its state, and folds the low-frequency rows', () => {
    const items = sessionMenu('tab', { ...live, pinned: true }, handledBy('tab'))
    expect(items.find((item) => item.id === 'pin')?.label.key).toBe('task.unpin')
    expect(items.filter((item) => item.fold).map((item) => item.id)).toEqual(['sidebar-pin', 'fork', 'reload', 'copy-id', 'legacy-history'])
  })
})
