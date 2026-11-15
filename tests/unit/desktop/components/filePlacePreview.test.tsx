// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { tellFilePlace, useFilePlace } from '../../../../apps/desktop/src/components/preview/file-place'
import { DocumentPreviewContent } from '../../../../apps/desktop/src/components/chat/DocumentPreviewContent'
import { HtmlPreviewSurface } from '../../../../apps/desktop/src/components/preview/HtmlPreviewSurface'
import { PREVIEW_LINK_SCRIPT } from '../../../../apps/desktop/src/session/shared/preview/preview-link-script'
import type { FilePlace } from '@gugu/core/shared/ui/guguLink'

/**
 * A link's place in a chat file the host previews: `#page=N` opens a PDF at that page, `#id` an HTML page at that element.
 * The preview about to open takes it when it mounts; one already open takes it now, and again for the same place.
 */

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

function Probe({ itemId, seen }: { itemId: string; seen: (FilePlace | undefined)[] }) {
  seen.push(useFilePlace(itemId))
  return null
}

it('the preview about to open takes the place on mount; one open takes each telling, the same place again too', async () => {
  const seen: (FilePlace | undefined)[] = []
  tellFilePlace('doc-1', { page: '3' })
  await harness.render(createElement(Probe, { itemId: 'doc-1', seen }))
  expect(seen.at(-1)).toEqual({ page: '3' })
  const first = seen.at(-1)
  await act(async () => tellFilePlace('doc-1', { page: '3' }))
  expect(seen.at(-1)).toEqual({ page: '3' })
  expect(seen.at(-1)).not.toBe(first)
  // Another file's place is not this preview's, and waits for its own.
  await act(async () => tellFilePlace('doc-2', { page: '9' }))
  expect(seen.at(-1)).toEqual({ page: '3' })
})

it('control: a place nobody took within 30 s is not taken by a later preview of that file', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  tellFilePlace('doc-3', { page: '4' })
  vi.setSystemTime(Date.now() + 31_000)
  const seen: (FilePlace | undefined)[] = []
  await harness.render(createElement(Probe, { itemId: 'doc-3', seen }))
  expect(seen.at(-1)).toBeUndefined()
})

const PDFJS = '../../../../apps/desktop/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
const PDF_VIEWER = '../../../../apps/desktop/node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs'

/** pdf.js's viewer, as far as the preview drives it: pages come in, the current page is set and announced. */
function fakeViewer() {
  class EventBus {
    listeners = new Map<string, ((event: object) => void)[]>()
    on(name: string, listener: (event: object) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
    dispatch(name: string, event: object) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
  }
  class PDFViewer {
    page = 1
    eventBus: EventBus
    currentScale = 1
    currentScaleValue = 'auto'
    constructor({ eventBus }: { eventBus: EventBus }) { this.eventBus = eventBus }
    setDocument() { queueMicrotask(() => this.eventBus.dispatch('pagesinit', {})) }
    get currentPageNumber() { return this.page }
    set currentPageNumber(page: number) { this.page = page; this.eventBus.dispatch('pagechanging', { pageNumber: page }) }
  }
  return { EventBus, LinkTarget: { BLANK: 2 }, PDFFindController: class {}, PDFLinkService: class { setViewer() {} setDocument() {} }, PDFViewer }
}

it.each([['3', '3'], ['9', '5'], ['x', '1']])('a PDF opens at page=%s (page %s of 5)', async (page, shown) => {
  const document = { numPages: 5, getOutline: async () => null, destroy() {} }
  vi.doMock(PDFJS, () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(document), destroy() {} }) }))
  vi.doMock(PDF_VIEWER, fakeViewer)
  await harness.render(createElement(DocumentPreviewContent, { kind: 'pdf', content: new ArrayBuffer(0), title: 'report.pdf', at: { page } }))
  await vi.waitFor(() => {
    expect(harness.container.querySelector<HTMLInputElement>('.document-preview-page-input')!.value).toBe(shown)
    expect(harness.container.querySelector('.document-preview-page-count')!.textContent).toBe('/ 5')
  })
  vi.doUnmock(PDFJS)
  vi.doUnmock(PDF_VIEWER)
})

const restores = (frame: HTMLIFrameElement) => (frame.contentWindow!.postMessage as ReturnType<typeof vi.fn>).mock.calls
  .map(([message]) => message as { type: string }).filter((message) => message.type === 'gugu-preview-restore-scroll')

it('an HTML page loading goes to the anchor instead of the kept position; one shown goes there now, again for the same anchor', async () => {
  const draw = (anchor?: { id: string }) => harness.render(createElement(HtmlPreviewSurface, { fileName: 'page.html', url: 'blob:page', onLink() {}, ...(anchor ? { anchor } : {}) }))
  await draw({ id: 'usage' })
  const frame = harness.container.querySelector('iframe')!
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: vi.fn(), configurable: true })
  await act(async () => frame.dispatchEvent(new Event('load')))
  expect(restores(frame)).toEqual([{ type: 'gugu-preview-restore-scroll', anchor: 'usage' }])
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'gugu-preview-restored' } })))
  await draw({ id: 'usage' })
  await draw({ id: 'install' })
  expect(restores(frame).slice(1)).toEqual([{ type: 'gugu-preview-restore-scroll', anchor: 'usage' }, { type: 'gugu-preview-restore-scroll', anchor: 'install' }])
  // Control: loaded again with no anchor named, it keeps its position.
  await act(async () => frame.dispatchEvent(new Event('load')))
  expect(restores(frame).at(-1)).toEqual({ type: 'gugu-preview-restore-scroll', x: 0, y: 0 })
})

it('the page script scrolls to the element an anchor names (by id, else by name); none named, it keeps the position', () => {
  document.body.innerHTML = '<h2 id="usage">Usage</h2><a name="legacy"></a>'
  const usage = document.getElementById('usage')!, legacy = document.getElementsByName('legacy')[0]!
  usage.scrollIntoView = vi.fn(); legacy.scrollIntoView = vi.fn()
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  Function(PREVIEW_LINK_SCRIPT)()
  const restore = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'gugu-preview-restore-scroll', ...data } }))
  restore({ anchor: 'usage' })
  restore({ anchor: 'legacy' })
  restore({ anchor: 'nowhere' })
  expect(usage.scrollIntoView).toHaveBeenCalledTimes(1)
  expect(legacy.scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollTo).not.toHaveBeenCalled()
  restore({ x: 0, y: 40 })
  expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 40, behavior: 'instant' })
})
