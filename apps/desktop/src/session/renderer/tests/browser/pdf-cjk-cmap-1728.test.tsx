import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { PdfPreview } from '@/components/chat/PdfPreview'
import fixtureUrl from './fixtures/cff-cjk-no-tounicode.pdf?url'
import '@/i18n/registerMessagingCatalog'
import '@/components/chat/documentPreview.css'
import { until } from '../../../../../../../tests/support/awaitCondition'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  window.getSelection()?.removeAllRanges()
})

it('renders selectable and searchable CFF Chinese text without an embedded ToUnicode map', async () => {
  container = document.createElement('div')
  container.style.cssText = 'width:700px;height:600px'
  document.body.append(container)
  root = createRoot(container)
  const data = await (await fetch(fixtureUrl)).arrayBuffer()
  await act(async () => root!.render(createElement(PdfPreview, { data })))
  await until(
    'the PDF Latin control is rendered',
    () => container!.querySelector('.textLayer')?.textContent?.includes('Hello 123.') === true
  )
  expect(container.querySelector('.textLayer')!.textContent).toContain('中文预览测试')

  const chinese = [...container.querySelectorAll('.textLayer span')].find((span) =>
    span.textContent?.includes('中文预览测试')
  )!
  const canvas = container.querySelector<HTMLCanvasElement>('.canvasWrapper canvas')!
  const textBox = chinese.getBoundingClientRect(),
    canvasBox = canvas.getBoundingClientRect()
  const scale = canvas.width / canvasBox.width
  const pixels = canvas
    .getContext('2d')!
    .getImageData(
      Math.floor((textBox.left - canvasBox.left) * scale),
      Math.floor((textBox.top - canvasBox.top) * scale),
      Math.ceil(textBox.width * scale),
      Math.ceil(textBox.height * scale)
    ).data
  expect(
    pixels.some((channel, index) => index % 4 === 0 && channel < 128 && pixels[index + 3] > 0)
  ).toBe(true)
  const range = document.createRange()
  range.selectNodeContents(chinese)
  window.getSelection()!.addRange(range)
  expect(window.getSelection()!.toString()).toContain('中文预览测试')

  await act(async () =>
    container!.firstElementChild!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
    )
  )
  const input = container.querySelector<HTMLInputElement>('.document-preview-pdf-find-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '中文预览测试'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await until(
    'the PDF Chinese query has one match',
    () => container!.querySelector('.document-preview-pdf-find-count')?.textContent === '1 / 1'
  )
  await page.screenshot({ path: '__screenshots__/pdf-cjk-cmap-1728.png' })
})
