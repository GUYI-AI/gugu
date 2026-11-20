// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { selectionMenuApi } from '../../../../apps/desktop/src/session/app-runtime/selection-menu'
import { selectionMenu } from '../../../../apps/desktop/src/session/shared/extensions/file-selection'
import type { GuguHost } from '../../../../apps/desktop/src/session/app-runtime/host'

// `gugu.files.showSelection` (API 60): the host's selection menu drawn in the page from the table its file came with —
// moved, not drawn again, as the selection moves; not while the pointer is selecting or the selection is out of view; a
// press hands the selection to the host (Copy to its clipboard).
const selectionAction = vi.fn(async () => undefined)
const writeText = vi.fn(async () => undefined)
const host = { appFiles: { selectionAction }, clipboard: { writeText } } as unknown as GuguHost
const entry = { workspace: 'folder:d-1/w-1', id: 'AGENTS.md', name: 'AGENTS.md' }
const file = { workspace: 'folder:d-1/w-1', id: 'AGENTS.md' }
const rect = { x: 40, y: 60, width: 120, height: 18 }
const menu = () => document.querySelector<HTMLElement>('.gugu-selection-menu')
const ids = () => [...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map((button) => button.dataset.fileSelectionAction)
const pointer = (type: string) => document.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))

afterEach(() => { document.body.innerHTML = ''; selectionAction.mockClear(); writeText.mockClear() })

it('draws the file\'s table at the selection, moves the same menu, hides it while selecting and out of view, and hands a press to the host', () => {
  const api = selectionMenuApi(host)
  api.remember(entry, selectionMenu({ kind: 'chat', chatId: 'g-1' }, true, true, 'en-US'))
  api.show({ file, places: [{ at: { lines: '3' } }], text: 'words', rect })
  expect(ids()).toEqual(['copy', 'cite', 'send'])
  const drawn = menu()!
  expect(drawn.style.top).toBe(`${60 + 18 + 8}px`)
  api.show({ file, places: [{ at: { lines: '3' } }], text: 'words', rect: { ...rect, y: 100 } })
  expect(menu()).toBe(drawn)
  expect(drawn.style.top).toBe(`${100 + 18 + 8}px`)
  api.show({ file, places: [{ at: { lines: '3' } }], text: 'words', rect: { ...rect, y: -200 } })
  expect(menu()!.hidden).toBe(true)
  api.show({ file, places: [{ at: { lines: '3' } }], text: 'words', rect })
  expect(menu()!.hidden).toBe(false)
  pointer('pointerdown')
  expect(menu()).toBeNull()
  api.show({ file, places: [{ at: { lines: '3-4' } }], text: 'more words', rect })
  expect(menu()).toBeNull()
  pointer('pointerup')
  expect(ids()).toEqual(['copy', 'cite', 'send'])
  document.querySelector<HTMLButtonElement>('[data-file-selection-action="cite"]')!.click()
  expect(selectionAction).toHaveBeenCalledWith({ action: 'cite', file, places: [{ at: { lines: '3-4' } }], text: 'more words', rect, viewport: { width: window.innerWidth, height: window.innerHeight } })
  expect(menu()).toBeNull()
  api.show({ file, places: [{ at: { lines: '3' } }], text: 'words', rect })
  document.querySelector<HTMLButtonElement>('[data-file-selection-action="copy"]')!.click()
  expect(writeText).toHaveBeenCalledWith('words')
})

it('a pick with no words has no Copy; a file without a table, or null, draws nothing', () => {
  const api = selectionMenuApi(host)
  api.remember(entry, selectionMenu({ kind: 'chat', chatId: 'g-1' }, true, true, 'zh-CN'))
  api.show({ file, places: [{ at: { sheet: 'S1', cell: 'B2' }, label: 'S1!B2' }], rect })
  expect(ids()).toEqual(['cite', 'send'])
  expect(menu()!.textContent).toBe('引用发送')
  api.show(null)
  expect(menu()).toBeNull()
  api.show({ file: { workspace: 'folder:d-1/w-1', id: 'other.md' }, places: [{ at: { lines: '1' } }], text: 'x', rect })
  expect(menu()).toBeNull()
})

it('hands the host the version the page draws, so a pick on it points there', () => {
  const api = selectionMenuApi(host)
  const chatFile = { chat: '7b6a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', id: '11111111-1111-4111-8111-111111111111', version: 1 }
  api.remember(chatFile, selectionMenu({ kind: 'chat', chatId: chatFile.chat }, true, true, 'en-US'))
  api.show({ file: chatFile, places: [{ at: { lines: '2' } }], text: 'words', rect })
  document.querySelector<HTMLButtonElement>('[data-file-selection-action="cite"]')!.click()
  expect(selectionAction).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ id: chatFile.id, version: 1 }) }))
})
