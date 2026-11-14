import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

let host: HTMLDivElement, root: Root
afterEach(async () => {
  root?.unmount()
  host?.remove()
  document.getSelection()?.removeAllRanges()
})

it.each([390, 1000])('keeps native source selection and its comment popup usable at %spx', async width => {
  await page.viewport(width, 700)
  const save = vi.fn()
  host = document.createElement('div')
  Object.assign(host.style, { width: '100%', maxWidth: '480px', fontSize: '14px', paddingTop: '100px' })
  document.body.append(host)
  root = createRoot(host)
  root.render(<FileTextContent fileName="example.ts" kind="text" content={'first\nsecond\nthird'} onAnnotate={save} />)
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
  await until('the selected range offers a comment', () => !!document.querySelector('.gg-file-annotation-popup button'))
  await page.elementLocator(document.querySelector('.gg-file-annotation-popup button')!).click()
  await until('the comment input has focus', () => document.activeElement?.tagName === 'TEXTAREA')
  const box = document.querySelector('.gg-file-annotation-popup')!.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(width)
  await page.elementLocator(document.querySelector('textarea')!).fill('Use a clearer name')
  await page.elementLocator(document.querySelector('.gg-file-annotation-form button[type="submit"]')!).click()
  await until('the quote and comment reach the source callback', () => save.mock.calls.length === 1)
  expect(save).toHaveBeenCalledWith({ startLine: 2, endLine: 2, text: 'second', annotation: 'Use a clearer name' })
})
