import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { runFileSelection } from '@renderer/features/sessions/annotations/file-selection-overlay'
import { SelectionLineLayer } from '@renderer/features/sessions/annotations/selection-line'
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations'
import type { FileSelectionAsk } from '@shared/extensions/file-selection'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@/styles/tokens.css'

// Comment pressed on an App page's selection menu reaches the window (the menu itself is the page's runtime's). Here
// the page is a plain box of the same size: what is judged is the host's half — the comment box.
let guest: HTMLDivElement, host: HTMLDivElement, root: Root
beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<SelectionLineLayer />))
  guest = document.createElement('div')
  Object.assign(guest.style, { position: 'fixed', left: '20px', top: '20px', width: '400px', height: '300px' })
  guest.tabIndex = -1
  document.body.append(guest)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  guest.remove()
})

const chatId = crypto.randomUUID()
const ask = (): FileSelectionAsk => ({
  webContentsId: 7, action: 'send', conversation: { kind: 'chat', chatId },
  file: { name: 'AGENTS.md', target: '/home/me/work/AGENTS.md' },
  pick: { text: 'run the gates', places: [{ at: { lines: '12-13' } }] },
  rect: { x: 40, y: 60, width: 120, height: 18 }, viewport: { width: 400, height: 300 },
})
const line = () => document.querySelector('[data-annotation-editor]')

it('Comment opens the numbered box at the selection; saved, the comment joins the draft and nothing is sent; a press elsewhere dismisses it', async () => {
  const draft = sessionAnnotations.forConversation({ kind: 'chat', chatId })
  draft.clear()
  await act(async () => runFileSelection(guest, null, ask()))
  await until('the box is open at the selection', () => !!line())
  expect(line()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(20)
  expect(line()!.textContent).toContain('1')
  await act(async () => { await userEvent.keyboard('Say which gates{Enter}') })
  await until('the comment joins the draft', () => draft.items.length === 1)
  expect(draft.items[0]).toMatchObject({ kind: 'file', file: ask().file, places: [{ at: { lines: '12-13' } }], text: 'run the gates', annotation: 'Say which gates', number: 1 })
  await until('the box goes once saved', () => !line())
  await act(async () => runFileSelection(guest, null, ask()))
  await until('opened again, numbered next', () => !!line() && line()!.textContent!.includes('2'))
  await act(async () => { await userEvent.click(guest) })
  await until('a press elsewhere dismisses it', () => !line())
  expect(draft.items).toHaveLength(1)
  draft.clear()
})
