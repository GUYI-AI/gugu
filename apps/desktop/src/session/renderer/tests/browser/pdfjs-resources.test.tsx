import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { PdfPreview } from '@/components/chat/PdfPreview'
import cjkFixtureUrl from './fixtures/cff-cjk-no-tounicode.pdf?url'
import dingbatsFixtureUrl from './fixtures/standard-font-zapfdingbats.pdf?url'
import jpxFixtureUrl from './fixtures/jpx-image.pdf?url'
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

async function preview(url: string) {
  container = document.createElement('div')
  container.style.cssText = 'width:700px;height:600px'
  document.body.append(container)
  root = createRoot(container)
  const data = await (await fetch(url)).arrayBuffer()
  await act(async () => root!.render(createElement(PdfPreview, { data })))
  return container
}

/** The red channel and alpha of the page canvas at a point given in PDF user space (origin bottom left). */
function pagePixel(view: HTMLElement, x: number, y: number, page = { width: 300, height: 200 }) {
  const canvas = view.querySelector<HTMLCanvasElement>('.canvasWrapper canvas')
  if (!canvas?.width) return undefined
  const [red, green, , alpha] = canvas
    .getContext('2d')!
    .getImageData(Math.floor((x / page.width) * canvas.width), Math.floor((1 - y / page.height) * canvas.height), 1, 1).data
  return { red, green, alpha }
}

// #1728: an embedded CID CFF font without ToUnicode needs the predefined CMap (`cMapUrl`).
it('renders selectable and searchable CFF Chinese text without an embedded ToUnicode map', async () => {
  const view = await preview(cjkFixtureUrl)
  await until(
    'the PDF Latin control is rendered',
    () => view.querySelector('.textLayer')?.textContent?.includes('Hello 123.') === true
  )
  expect(view.querySelector('.textLayer')!.textContent).toContain('中文预览测试')

  const chinese = [...view.querySelectorAll('.textLayer span')].find((span) =>
    span.textContent?.includes('中文预览测试')
  )!
  const canvas = view.querySelector<HTMLCanvasElement>('.canvasWrapper canvas')!
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
    view.firstElementChild!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
    )
  )
  const input = view.querySelector<HTMLInputElement>('.document-preview-pdf-find-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '中文预览测试'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await until(
    'the PDF Chinese query has one match',
    () => view.querySelector('.document-preview-pdf-find-count')?.textContent === '1 / 1'
  )
})

// Non-embedded ZapfDingbats has no system substitute: pdf.js reads FoxitDingbats.pfb from `standardFontDataUrl`
// and loads it as a font face named g_d<doc>_f<n>; without it only a local() substitute (g_d<doc>_sf<n>) is tried.
it('loads the standard font data for a non-embedded ZapfDingbats font', async () => {
  const earlier = new Set(document.fonts)
  const view = await preview(dingbatsFixtureUrl)
  await until(
    'the PDF Helvetica control is rendered',
    () => view.querySelector('.textLayer')?.textContent?.includes('Dingbats control') === true
  )
  await until('the ZapfDingbats font program is loaded', () =>
    [...document.fonts].some((face) => !earlier.has(face) && /g_d\d+_f\d+/.test(face.family) && face.status === 'loaded')
  )
})

// A JPXDecode image is decoded by OpenJPEG, which pdf.js loads from `wasmUrl`.
it('decodes a JPEG 2000 image', async () => {
  const view = await preview(jpxFixtureUrl)
  await until(
    'the PDF Helvetica control is rendered',
    () => view.querySelector('.textLayer')?.textContent?.includes('JPX control') === true
  )
  await until('the JPX image is painted red', () => {
    const pixel = pagePixel(view, 84, 84)
    return pixel !== undefined && pixel.red > 200 && pixel.green < 60 && pixel.alpha > 0
  })
})
