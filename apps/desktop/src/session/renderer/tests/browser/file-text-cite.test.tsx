import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations'
import { AnnotationTray } from '@renderer/features/sessions/annotations/annotation-tray'
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

it.each([390, 1000])('keeps native source selection and its one Cite action usable at %spx', async width => {
  await page.viewport(width, 700)
  const cite = vi.fn()
  host = document.createElement('div')
  Object.assign(host.style, { width: '100%', maxWidth: '480px', fontSize: '14px', paddingTop: '100px' })
  document.body.append(host)
  root = createRoot(host)
  root.render(<FileTextContent kind="text" content={'first\nsecond\nthird'} onCite={cite} />)
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
  await until('the selected range offers Cite', () => !!document.querySelector('.gg-file-cite-popup button'))
  expect(document.querySelectorAll('.gg-file-cite-popup button')).toHaveLength(1)
  const box = document.querySelector('.gg-file-cite-popup')!.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(width)
  await page.elementLocator(document.querySelector('.gg-file-cite-popup button')!).click()
  await until('the selection reaches the cite callback', () => cite.mock.calls.length === 1)
  expect(cite).toHaveBeenCalledWith({ text: 'second', at: { lines: '2' }, code: true })
  await until('the action closes once cited', () => !document.querySelector('.gg-file-cite-popup'))
})

it('stores exact source selections and changes a file comment by deleting and selecting again', async () => {
  await page.viewport(960, 700)
  const sessionId = crypto.randomUUID(), path = 'docs/pricing.txt'
  const draft = sessionAnnotations.forSession(sessionId)
  host = document.createElement('div')
  host.className = 'gugu-skin'
  Object.assign(host.style, { width: '480px', paddingTop: '130px' })
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<><FileTextContent kind="text" content={'same line\nselected words\nselected words'}
      onCite={vi.fn()} annotation={{ sessionId, path }} /><AnnotationTray sessionId={sessionId} onSend={() => {}} enabled /></>)
  })
  const range = document.createRange()
  const selected = host.querySelector('[data-file-line="3"]')!.firstChild!
  range.setStart(selected, 0)
  range.setEnd(selected, 8)
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await until('the file offers annotation alongside cite', () => document.querySelectorAll('.gg-file-cite-popup button').length === 2)
  await act(async () => { await userEvent.click(document.querySelectorAll('.gg-file-cite-popup button')[1]!) })
  const editor = () => host.querySelector<HTMLFormElement>('[data-annotation-editor]')
  await until('the shared annotation field is mounted', () => !!editor())
  await act(async () => { await userEvent.keyboard('Clarify the pricing{Enter}') })
  expect(draft.items).toMatchObject([{ kind: 'file', path, startLine: 3, endLine: 3, text: 'selected', annotation: 'Clarify the pricing', number: 1 }])

  expect(editor()).toBeNull()
  expect(host.querySelector('[data-annotation-marker]')).toBeNull()
  await act(async () => { await userEvent.click(host.querySelector('[data-composer-annotations] button')!) })
  const remove = () => document.querySelector('button[aria-label="Delete annotation"],button[aria-label="删除批注"]')
  await until('the saved file comment can be deleted', () => !!remove())
  expect(document.querySelector('button[aria-label="Edit annotation"],button[aria-label="修改批注"]')).toBeNull()
  await act(async () => { await userEvent.click(remove()!) })
  expect(draft.items).toHaveLength(0)
  await until('the empty attachment closes', () => !host.querySelector('[data-composer-annotations]'))
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await until('the source can be selected again', () => document.querySelectorAll('.gg-file-cite-popup button').length === 2)
  await act(async () => { await userEvent.click(document.querySelectorAll('.gg-file-cite-popup button')[1]!) })
  await until('the new comment input is mounted', () => !!editor())
  await act(async () => { await userEvent.keyboard('Use monthly totals{Enter}') })
  expect(draft.items).toMatchObject([{ kind: 'file', path, startLine: 3, endLine: 3, text: 'selected', number: 2, annotation: 'Use monthly totals' }])
})
