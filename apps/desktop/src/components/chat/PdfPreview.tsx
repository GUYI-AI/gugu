import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ListTree, Maximize2, Minimize2, Search, X } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useTranslation } from 'react-i18next'
import { usePinchZoom } from '../../hooks/usePinchZoom'
import { Button } from '../ui/Button'
import type { FilePlace } from '@gugu/core/shared/ui/guguLink'
import { DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM, pinchZoom } from '@/session/shared/preview/pinch-zoom'
import { useFileZoom } from '../preview/file-content-zoom'

type Fit = 'page-width' | 'page-fit'
type OutlineItem = { title: string; dest: string | unknown[] | null; url?: string | null; items: OutlineItem[] }
type Loaded = { document: PDFDocumentProxy; viewer: PDFViewer; eventBus: EventBus; linkService: PDFLinkService }

/**
 * A PDF read the way a browser's viewer reads it: every page in one scroll, drawn as it comes into view, with its links,
 * a page box, the document's outline and find across all pages. pdf.js's own viewer components draw it (the same
 * dependency, one renderer on desktop, phone and remote files); the reading zoom stays the one every view shares.
 */
export function PdfPreview({ data, at }: { data: ArrayBuffer; at?: FilePlace }) {
  const { t } = useTranslation('messaging')
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<string>()
  const [pageNumber, setPageNumber] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [fit, setFit] = useState<Fit>('page-width')
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState({ current: 0, total: 0 })
  const { zoom, setZoom } = useFileZoom('pdf', rootRef)
  usePinchZoom(containerRef, (deltaY) => setZoom((value) => pinchZoom(value, deltaY, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)))

  useEffect(() => {
    const container = containerRef.current
    const pages = pagesRef.current
    if (!container || !pages) return
    let active = true
    let loadingTask: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined
    let shown: Pick<Loaded, 'viewer' | 'linkService'> | undefined
    // Another document (the file changed, or another file): nothing of the last one's reading carries over.
    setLoaded(undefined)
    setError(undefined)
    setOutline([])
    setOutlineOpen(false)
    setPageNumber(1)
    setFindOpen(false)
    setQuery('')
    setMatches({ current: 0, total: 0 })
    void (async () => {
      // The viewer module reads pdf.js from `globalThis.pdfjsLib`, which pdf.mjs sets: load it first.
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      loadingTask = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false })
      const document = await loadingTask.promise
      const { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
      if (!active) return
      const eventBus = new EventBus()
      const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' })
      const findController = new PDFFindController({ eventBus, linkService })
      const viewer = new PDFViewer({ container, viewer: pages, eventBus, linkService, findController })
      linkService.setViewer(viewer)
      shown = { viewer, linkService }
      eventBus.on('pagechanging', ({ pageNumber: page }: { pageNumber: number }) => setPageNumber(page))
      eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setMatches(matchesCount))
      eventBus.on('updatefindcontrolstate', ({ matchesCount }: { matchesCount?: { current: number; total: number } }) => { if (matchesCount) setMatches(matchesCount) })
      eventBus.on('pagesinit', () => { if (active) setLoaded({ document, viewer, eventBus, linkService }) }, { once: true })
      viewer.setDocument(document)
      linkService.setDocument(document)
      const items = await document.getOutline()
      if (active) setOutline((items ?? []) as OutlineItem[])
    })().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      active = false
      // The viewer lets go of its pages first; destroying the task then ends the document and its worker.
      shown?.viewer.setDocument(null as unknown as PDFDocumentProxy)
      shown?.linkService.setDocument(null)
      void loadingTask?.destroy()
    }
  }, [data])

  // The fit names the scale at 100%; the reading zoom multiplies it. Again whenever the viewer's width changes.
  const applyScale = useCallback(() => {
    if (!loaded) return
    loaded.viewer.currentScaleValue = fit
    loaded.viewer.currentScale = loaded.viewer.currentScale * zoom
  }, [loaded, fit, zoom])
  useEffect(() => {
    applyScale()
    const container = containerRef.current
    if (!container) return
    // The width always sets the scale; the height only when the whole page has to fit.
    let size = [container.clientWidth, container.clientHeight]
    const observer = new ResizeObserver(() => {
      const next = [container.clientWidth, container.clientHeight]
      if (next[0] !== size[0] || (fit === 'page-fit' && next[1] !== size[1])) applyScale()
      size = next
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [applyScale, fit])

  // A link's `page=N`: that page once the document is read, the last one past its end.
  useEffect(() => {
    const page = Number(at?.page)
    if (loaded && Number.isInteger(page) && page >= 1) loaded.viewer.currentPageNumber = Math.min(page, loaded.document.numPages)
  }, [loaded, at])

  // Not while the box is being typed in: scrolling would overwrite what is half typed.
  const pageInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (window.document.activeElement !== pageInputRef.current) setPageInput(String(pageNumber)) }, [pageNumber])

  const find = useCallback((type: '' | 'again', findPrevious = false, text = query) => {
    loaded?.eventBus.dispatch('find', { source: null, type, query: text, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false })
  }, [loaded, query])
  const closeFind = () => {
    setFindOpen(false)
    setQuery('')
    setMatches({ current: 0, total: 0 })
    loaded?.eventBus.dispatch('findbarclose', { source: null })
  }
  const openFind = () => {
    setFindOpen(true)
    requestAnimationFrame(() => findRef.current?.select())
  }
  const onRootKey = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      openFind()
    }
  }

  const goToPage = (value: string) => {
    const page = Number(value)
    if (!loaded || !Number.isInteger(page)) { setPageInput(String(pageNumber)); return }
    loaded.viewer.currentPageNumber = Math.min(Math.max(page, 1), loaded.document.numPages)
    setPageInput(String(loaded.viewer.currentPageNumber))
  }
  const outlineRef = useRef<HTMLElement>(null)
  const openOutlineItem = (item: OutlineItem) => {
    if (item.dest) void loaded?.linkService.goToDestination(item.dest)
    else if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer')
    // Lying over the pages (a narrow pane): out of the way of the place it went to.
    if (outlineRef.current && getComputedStyle(outlineRef.current).position === 'absolute') setOutlineOpen(false)
  }

  const pageCount = loaded?.document.numPages ?? 0
  return (
    <div ref={rootRef} className="document-preview-pdf" onKeyDownCapture={onRootKey}>
      {error ? null : <div className="document-preview-toolbar document-preview-pdf-toolbar" role="toolbar" aria-label={t('chatArea.filePreview.pdfControls')}>
        <div className="document-preview-pdf-toolbar-side">
          {outline.length > 0 ? <Button variant="ghost" size="icon" aria-pressed={outlineOpen} aria-label={t('chatArea.filePreview.outline')} title={t('chatArea.filePreview.outline')} onClick={() => setOutlineOpen((open) => !open)}><ListTree size={17} /></Button> : null}
        </div>
        <div className="document-preview-pdf-pages">
          <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.previousPage')} title={t('chatArea.filePreview.previousPage')} disabled={pageNumber <= 1} onClick={() => loaded?.viewer.previousPage()}><ChevronLeft size={17} /></Button>
          <input
            ref={pageInputRef}
            className="document-preview-page-input"
            aria-label={t('chatArea.filePreview.pageNumber')}
            inputMode="numeric"
            disabled={!pageCount}
            value={pageCount ? pageInput : ''}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))}
            onBlur={(event) => goToPage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <span className="document-preview-page-count">/ {pageCount || '–'}</span>
          <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.nextPage')} title={t('chatArea.filePreview.nextPage')} disabled={!pageCount || pageNumber >= pageCount} onClick={() => loaded?.viewer.nextPage()}><ChevronRight size={17} /></Button>
        </div>
        <div className="document-preview-pdf-toolbar-side document-preview-pdf-toolbar-end">
          <Button variant="ghost" size="icon" aria-label={fit === 'page-width' ? t('chatArea.filePreview.fitPage') : t('chatArea.filePreview.fitWidth')} title={fit === 'page-width' ? t('chatArea.filePreview.fitPage') : t('chatArea.filePreview.fitWidth')} disabled={!pageCount} onClick={() => setFit((value) => value === 'page-width' ? 'page-fit' : 'page-width')}>{fit === 'page-width' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Button>
          <Button variant="ghost" size="icon" aria-pressed={findOpen} aria-label={t('chatArea.filePreview.find')} title={t('chatArea.filePreview.find')} disabled={!pageCount} onClick={() => findOpen ? closeFind() : openFind()}><Search size={16} /></Button>
        </div>
      </div>}
      {findOpen ? (
        <div className="document-preview-pdf-find" role="search">
          <input
            ref={findRef}
            className="document-preview-pdf-find-input"
            aria-label={t('chatArea.filePreview.find')}
            placeholder={t('chatArea.filePreview.find')}
            value={query}
            onChange={(event) => { setQuery(event.target.value); find('', false, event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); find('again', event.shiftKey) }
              if (event.key === 'Escape') { event.preventDefault(); closeFind() }
            }}
          />
          <span className="document-preview-pdf-find-count">{query ? `${matches.total ? matches.current : 0} / ${matches.total}` : ''}</span>
          <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.findPrevious')} title={t('chatArea.filePreview.findPrevious')} disabled={!matches.total} onClick={() => find('again', true)}><ChevronUp size={16} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.findNext')} title={t('chatArea.filePreview.findNext')} disabled={!matches.total} onClick={() => find('again')}><ChevronDown size={16} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.closeFind')} title={t('chatArea.filePreview.closeFind')} onClick={closeFind}><X size={16} /></Button>
        </div>
      ) : null}
      <div className="document-preview-pdf-body">
        {outlineOpen && outline.length > 0 ? (
          <nav ref={outlineRef} className="document-preview-pdf-outline" aria-label={t('chatArea.filePreview.outline')} onKeyDown={(event) => { if (event.key === 'Escape') setOutlineOpen(false) }}>
            <OutlineList items={outline} onOpen={openOutlineItem} />
          </nav>
        ) : null}
        <div className="document-preview-pdf-viewport">
          <div ref={containerRef} className="document-preview-pdf-scroller">
            <div ref={pagesRef} className="pdfViewer" data-file-selection />
          </div>
          {error ? <div className="document-preview-status document-preview-status-error"><span>{t('chatArea.filePreview.renderFailed')}</span><span className="document-preview-status-detail">{error}</span></div> : !loaded ? <div className="document-preview-status"><LoadingIndicator size="inline" />{t('chatArea.filePreview.rendering')}</div> : null}
        </div>
      </div>
    </div>
  )
}

function OutlineList({ items, onOpen }: { items: OutlineItem[]; onOpen: (item: OutlineItem) => void }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>
          <Button variant="ghost" size="sm" className="document-preview-pdf-outline-item" title={item.title} onClick={() => onOpen(item)}>{item.title}</Button>
          {item.items.length > 0 ? <OutlineList items={item.items} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  )
}
