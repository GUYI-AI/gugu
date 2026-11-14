import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An App's menu is the host's (`showContextMenu`): the person's click on an item lands in the host, not in the App's
 * page. The App then writes the clipboard with what was picked (the Folder App's 「复制这一块的链接」), which needs the
 * person's gesture on the page — so the pick hands the page one before it answers, as a command does
 * (`invokeExtensionCommand`). Dismissing the menu hands nothing.
 */

const menu = vi.hoisted(() => ({ entries: [] as Array<{ id?: string; click?: () => void }>, dismiss: () => undefined as void }))
const page = vi.hoisted(() => ({
  isDestroyed: () => false,
  executeJavaScript: vi.fn(async () => 0),
  hostWebContents: { mainFrame: { executeJavaScript: async () => ({ x: 0, y: 0 }) } },
}))
vi.mock('electron', () => ({
  webContents: { fromId: () => page },
  BrowserWindow: { fromWebContents: () => ({}) },
}))
vi.mock('../../../../apps/desktop/electron/content-context-menu', () => ({
  showContentContextMenu: (entries: typeof menu.entries, _at: unknown, onClose: () => void) => {
    menu.entries = entries
    menu.dismiss = onClose
  },
}))

const { showAppContextMenu } = await import('../../../../apps/desktop/electron/session/main/core/extensions/app-context-menu')
const items = { x: 4, y: 8, items: [{ id: 'copy-link', label: 'Copy link' }] }

describe("a pick in an App's host menu is the person's gesture on the page", () => {
  beforeEach(() => page.executeJavaScript.mockClear())

  it('the page is given a gesture before the pick is answered', async () => {
    const order: string[] = []
    page.executeJavaScript.mockImplementationOnce(async () => { order.push('gesture'); return 0 })
    const picked = showAppContextMenu(1, items).then((id) => { order.push(`answer ${id}`); return id })
    await vi.waitFor(() => expect(menu.entries).toHaveLength(1))
    menu.entries[0]!.click!()
    expect(await picked).toBe('copy-link')
    expect(page.executeJavaScript).toHaveBeenCalledExactlyOnceWith('0', true)
    expect(order).toEqual(['gesture', 'answer copy-link'])
  })

  it('a dismissed menu answers null and gives the page nothing', async () => {
    menu.entries = []
    const picked = showAppContextMenu(1, items)
    await vi.waitFor(() => expect(menu.entries).toHaveLength(1))
    menu.dismiss()
    expect(await picked).toBeNull()
    expect(page.executeJavaScript).not.toHaveBeenCalled()
  })
})
