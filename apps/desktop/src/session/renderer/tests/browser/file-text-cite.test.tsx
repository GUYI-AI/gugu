import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { SelectionLineLayer } from '@renderer/features/sessions/annotations/selection-line'
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@/styles/tokens.css'

let host: HTMLDivElement, root: Root
afterEach(async () => {
  root?.unmount()
  host?.remove()
  document.getSelection()?.removeAllRanges()
})

it.each([390, 1000])('keeps native source selection and the one menu (Copy · Comment) usable at %spx', async width => {
  await page.viewport(width, 700)
  host = document.createElement('div')
  Object.assign(host.style, { width: '100%', maxWidth: '480px', fontSize: '14px', paddingTop: '100px' })
  document.body.append(host)
  root = createRoot(host)
  const file = { name: 'notes.txt', target: '/home/me/notes.txt' }
  root.render(<FileTextContent kind="text" content={'first\nsecond\nthird'} selectable={{ conversation: { kind: 'chat', chatId: 'g-1' }, file, sends: true }} />)
  await until('the file has rendered its source lines', () => host.querySelectorAll('.gg-file-source-row').length === 3)
  const rows = [...host.querySelectorAll<HTMLElement>('.gg-file-source-row')]
  const lineHeight = parseFloat(getComputedStyle(host.querySelector('.gg-file-source')!).lineHeight)
  expect(rows[0].getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight + 1)
  expect(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top).toBeCloseTo(lineHeight, 0)
  const range = document.createRange()
  range.selectNodeContents(host.querySelector('[data-file-line="2"]')!)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await until('the selected range offers the menu', () => !!document.querySelector('.gugu-selection-menu button'))
  expect([...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map(button => button.dataset.fileSelectionAction)).toEqual(['copy', 'send'])
  const box = document.querySelector('.gugu-selection-menu')!.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(width)
})

it('comments on a source selection into the conversation\'s draft: the file where it is, its lines and words; nothing is sent', async () => {
  await page.viewport(960, 700)
  const chatId = crypto.randomUUID(), path = '/home/task/docs/pricing.txt'
  const draft = sessionAnnotations.forConversation({ kind: 'chat', chatId })
  host = document.createElement('div')
  host.className = 'gugu-skin'
  Object.assign(host.style, { width: '480px', paddingTop: '130px' })
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<><FileTextContent kind="text" content={'same line\nselected words\nselected words'}
      selectable={{ conversation: { kind: 'chat', chatId }, file: { name: 'pricing.txt', target: path }, sends: true }} /><SelectionLineLayer /></>)
  })
  const range = document.createRange()
  const selected = host.querySelector('[data-file-line="3"]')!.firstChild!
  range.setStart(selected, 0)
  range.setEnd(selected, 8)
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await until('the file offers Copy · Comment', () => document.querySelectorAll('.gugu-selection-menu button').length === 2)
  expect([...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map(button => button.dataset.fileSelectionAction)).toEqual(['copy', 'send'])
  await act(async () => { await userEvent.click(document.querySelector('.gugu-selection-menu [data-file-selection-action="send"]')!) })
  const editor = () => document.querySelector<HTMLFormElement>('[data-annotation-editor]')
  await until('the line is open at the selection', () => !!editor())
  await act(async () => { await userEvent.keyboard('Clarify the pricing{Enter}') })
  await until('the comment joins the draft', () => draft.items.length === 1)
  expect(draft.items[0]).toMatchObject({ kind: 'file', file: { name: 'pricing.txt', target: path }, places: [{ at: { lines: '3' } }], text: 'selected words', annotation: 'Clarify the pricing' })
  await until('the box goes once saved', () => !editor())
  draft.clear()
})
