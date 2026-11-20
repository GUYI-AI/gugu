import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatStoreProvider } from '@/store/chatContext'
import { FileSelectionLayer } from '@renderer/features/sessions/annotations/file-selection-overlay'
import { chatStore } from '../../../../../../../tests/support/testHarness'
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

it.each([390, 1000])('keeps native source selection and the one menu (a phone\'s: Copy · Cite) usable at %spx', async width => {
  await page.viewport(width, 700)
  const cite = vi.fn()
  host = document.createElement('div')
  Object.assign(host.style, { width: '100%', maxWidth: '480px', fontSize: '14px', paddingTop: '100px' })
  document.body.append(host)
  root = createRoot(host)
  const file = { name: 'notes.txt', target: '/home/me/notes.txt' }
  root.render(<FileTextContent kind="text" content={'first\nsecond\nthird'} selectable={{ conversation: { kind: 'chat', chatId: 'g-1' }, file, cite, sends: false }} />)
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
  expect([...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map(button => button.dataset.fileSelectionAction)).toEqual(['copy', 'cite'])
  const box = document.querySelector('.gugu-selection-menu')!.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(width)
  await page.elementLocator(document.querySelector('.gugu-selection-menu [data-file-selection-action="cite"]')!).click()
  await until('the selection reaches the cite callback', () => cite.mock.calls.length === 1)
  expect(cite.mock.calls[0]![0]).toMatchObject({ refs: [], quote: expect.stringMatching(/second[\s\S]*\/home\/me\/notes\.txt$/) })
  await until('the action closes once cited', () => !document.querySelector('.gugu-selection-menu'))
})

it('sends a source selection with the person\'s line into the conversation, the file named where it is', async () => {
  await page.viewport(960, 700)
  const chatId = crypto.randomUUID(), path = '/home/task/docs/pricing.txt'
  const sendMessageToChat = vi.fn(async () => 'message-1')
  host = document.createElement('div')
  host.className = 'gugu-skin'
  Object.assign(host.style, { width: '480px', paddingTop: '130px' })
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<ChatStoreProvider value={chatStore({ sendMessageToChat })}><FileTextContent kind="text" content={'same line\nselected words\nselected words'}
      selectable={{ conversation: { kind: 'chat', chatId }, file: { name: 'pricing.txt', target: path }, cite: vi.fn(), sends: true }} /><FileSelectionLayer /></ChatStoreProvider>)
  })
  const range = document.createRange()
  const selected = host.querySelector('[data-file-line="3"]')!.firstChild!
  range.setStart(selected, 0)
  range.setEnd(selected, 8)
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await until('the file offers Copy · Cite · Send', () => document.querySelectorAll('.gugu-selection-menu button').length === 3)
  expect([...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map(button => button.dataset.fileSelectionAction)).toEqual(['copy', 'cite', 'send'])
  await act(async () => { await userEvent.click(document.querySelector('.gugu-selection-menu [data-file-selection-action="send"]')!) })
  const editor = () => document.querySelector<HTMLFormElement>('[data-annotation-editor]')
  await until('the line is open at the selection', () => !!editor())
  await act(async () => { await userEvent.keyboard('Clarify the pricing{Enter}') })
  await until('sent into the chat', () => sendMessageToChat.mock.calls.length === 1)
  // The cite as Cite makes it (a code file's lines whole, fenced; in a chat a computer's file by its path), then the line.
  expect(sendMessageToChat).toHaveBeenCalledWith(chatId, expect.stringMatching(/^> ```\n> selected words\n> ```\n\npricing\.txt \([^)]+\): \/home\/task\/docs\/pricing\.txt\n\nClarify the pricing$/))
  await until('the line goes once sent', () => !editor())
})
