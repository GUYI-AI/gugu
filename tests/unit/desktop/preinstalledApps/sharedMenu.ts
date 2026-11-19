// The host's shared menu (gugu.showContextMenu) as a Files App test sees it: the App hands the host its items and waits
// for the id picked, or null when the menu closes without one. This fake keeps the menu the App last opened and lets a
// test read it and pick from it as a person would, by labels (a submenu row's label, then a row inside it).
import { vi } from 'vitest'

export type SharedItem = {
  type?: 'separator'; id?: string; label?: string; enabled?: boolean; checked?: boolean; danger?: boolean; title?: string; person?: string; items?: SharedItem[]
}
type Open = { x: number; y: number; items: SharedItem[]; resolve: (id: string | null) => void }

// A row by its label; a set filter's row (「上传者: 小雨」) by its name before 「: 」 too.
const named = (item: SharedItem, label: string) => item.type !== 'separator' && (item.label === label || !!item.label?.startsWith(`${label}: `))

const task = () => new Promise<void>((done) => setTimeout(done, 0))

export function fakeSharedMenu() {
  let open: Open | null = null
  const showContextMenu = vi.fn(({ x, y, items }: { x: number; y: number; items: SharedItem[] }) => {
    // A new menu takes the place of the open one, which answers nothing (the host's pending request is resolved null).
    open?.resolve(null)
    return new Promise<string | null>((resolve) => { open = { x, y, items, resolve } })
  })
  const level = (path: string[]) => {
    if (!open) throw new Error('no shared menu is open')
    let items = open.items
    for (const label of path) {
      const row = items.find((item) => named(item, label))
      if (!row?.items) throw new Error(`no submenu 「${label}」 in [${items.map((item) => item.label).join(', ')}]`)
      items = row.items
    }
    return items
  }
  const rowAt = (path: string[]) => {
    const label = path.at(-1)!
    const row = level(path.slice(0, -1)).find((item) => named(item, label))
    if (!row) throw new Error(`no row 「${label}」 in [${level(path.slice(0, -1)).map((item) => item.label).join(', ')}]`)
    return row
  }
  return {
    showContextMenu,
    /** Whether a menu is open. */
    isOpen: () => open !== null,
    /** Where it opened, App-local. */
    at: () => open && { x: open.x, y: open.y },
    /** The rows at a level (separators left out). */
    rows: (...path: string[]) => level(path).filter((item) => item.type !== 'separator'),
    /** The labels at a level (separators left out). */
    labels: (...path: string[]) => level(path).filter((item) => item.type !== 'separator').map((item) => item.label!),
    /** One row, by its labels from the top; a set filter's row is found by its name before 「: …」 too. */
    row: (...path: string[]) => rowAt(path),
    /** Picks a row as a press on it: the host closes the menu and answers its id. Enabled leaves only, as the host.
     * A press is its own task (a host IPC message): what the page had in flight (a menu opened again once the folder
     * answers whether it may be deleted) lands first, and the row is read from the menu open then. */
    pick: async (...path: string[]) => {
      await task()
      const row = rowAt(path)
      if (row.items || row.enabled === false) throw new Error(`「${path.join(' › ')}」 cannot be picked`)
      const { resolve } = open!
      open = null
      resolve(row.id!)
      await task()
    },
    /** Closes it without a pick (Escape, a press elsewhere). */
    dismiss: async () => {
      await task()
      const was = open
      open = null
      was?.resolve(null)
      await task()
    },
  }
}
