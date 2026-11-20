import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { Markdown } from '../markdown/Markdown'
import { Button } from '../ui/Button'
import { useBackLayer } from '../ui/sheetStack'
import type { AnnotationConversation } from '@/session/shared/browser-annotation'
import { selectionMenu, type FileReference } from '@/session/shared/extensions/file-selection'
import { i18n } from '@/i18n'
import { fileTextRange, sourceLineRange, type FileTextRange } from './file-text-range'
import { openSendLine } from '@renderer/features/sessions/annotations/file-selection-overlay'
import { FileSelectionMenu } from './FileSelectionMenu'
import { linesPlace, selectionCite, type SelectionCite } from './quote-preview-file'
import './file-text-content.css'

type Selection = { range: Range; quote: FileTextRange }

/**
 * What a file's text preview can do with a selection: whose conversation it is and how its readers name the file
 * (file-selection.ts), where a cite goes on this platform, and whether a Send can go out from here.
 */
export interface FileTextSelection {
  conversation: AnnotationConversation | null
  file: FileReference | null
  cite: (cite: SelectionCite) => void | Promise<void>
  sends: boolean
}

/** The file's existing native selection (including touch handles) offers the host's one selection menu (FileSelectionMenu). */
export function FileTextContent({ content, kind, style, selectable }: {
  content: string
  kind: 'text' | 'markdown'
  style?: CSSProperties
  selectable?: FileTextSelection
}) {
  const { t } = useTranslation('messaging')
  const container = useUiPortalContainer()
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const selecting = useRef(false)
  const lineAnchor = useRef<number | null>(null)
  const dragging = useRef<number | null>(null)
  const selectedLines = useRef<Selection | null>(null)
  const lines = content.split(/\r?\n/)
  const close = () => { selectedLines.current = null; setSelection(null) }
  useBackLayer(close, !!selection)

  useEffect(() => {
    const element = root.current
    if (!element || !selectable) return
    const doc = element.ownerDocument
    let frame = 0
    const capture = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (selecting.current) return
        const selected = doc.getSelection()
        const range = selected?.rangeCount ? selected.getRangeAt(0) : null
        const lines = selectedLines.current
        const sameLines = range && lines && range.startContainer === lines.range.startContainer && range.startOffset === lines.range.startOffset
          && range.endContainer === lines.range.endContainer && range.endOffset === lines.range.endOffset
        const quote = sameLines ? lines.quote : range && fileTextRange(element, range, content, kind)
        setSelection(quote && range ? { range: range.cloneRange(), quote } : null)
      })
    }
    const up = () => { selecting.current = false; dragging.current = null; capture() }
    doc.addEventListener('selectionchange', capture)
    doc.addEventListener('pointerup', up)
    doc.addEventListener('pointercancel', up)
    return () => {
      cancelAnimationFrame(frame)
      doc.removeEventListener('selectionchange', capture)
      doc.removeEventListener('pointerup', up)
      doc.removeEventListener('pointercancel', up)
    }
  }, [content, kind, selectable])

  const selectLines = (from: number, to: number) => {
    const element = root.current
    const quote = sourceLineRange(content, from, to)
    const first = element?.querySelector(`[data-file-line="${quote.startLine}"]`)
    const last = element?.querySelector(`[data-file-line="${quote.endLine}"]`)
    if (!element || !first || !last) return
    const range = element.ownerDocument.createRange()
    range.setStart(first, 0)
    range.setEnd(last, last.childNodes.length)
    const selected = element.ownerDocument.getSelection()
    selected?.removeAllRanges()
    selected?.addRange(range)
    selectedLines.current = { range, quote }
    setSelection({ range, quote })
  }
  const conversation = selectable?.conversation, file = selectable?.file
  const items = useMemo(() => selectable ? selectionMenu(selectable.conversation, Boolean(selectable.file), selectable.sends, i18n.language) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by value: callers hand a new object each render
    [JSON.stringify(selectable?.conversation ?? null), Boolean(selectable?.file), selectable?.sends])
  const citeOf = ({ quote: { startLine, endLine, text } }: Selection) =>
    selectionCite(conversation!, file!, { text, places: [linesPlace(startLine, endLine)], ...(kind === 'text' ? { code: true } : {}) })
  return <>
    <div ref={root} style={style} data-file-cite={selectable ? '' : undefined}
      onPointerDown={event => {
        if (!(event.target instanceof Element) || !event.target.closest('.gg-file-line-number')) selectedLines.current = null
        if (event.button === 0) { selecting.current = true; setSelection(null) }
      }}>
      {kind === 'markdown' ? <Markdown trust="chat" density="comfortable" content={content} hardBreaks sourceLines={!!selectable} />
        : selectable ? <div className="gg-file-source">
          {lines.map((line, index) => <div className="gg-file-source-row" key={index}>
            <Button variant="ghost" size="sm" className="gg-file-line-number" data-line={index + 1}
              aria-label={t('fileCite.selectLine', { line: index + 1 })}
              onPointerDown={event => {
                if (event.pointerType !== 'mouse' || event.button !== 0) return
                event.preventDefault()
                const from = event.shiftKey ? lineAnchor.current ?? index + 1 : index + 1
                lineAnchor.current = from
                dragging.current = from
                selectLines(from, index + 1)
              }}
              onPointerEnter={event => { if (dragging.current !== null && event.buttons === 1) selectLines(dragging.current, index + 1) }}
              onClick={event => {
                if (event.detail !== 0) return
                const from = event.shiftKey ? lineAnchor.current ?? index + 1 : index + 1
                lineAnchor.current = from
                selectLines(from, index + 1)
              }}>{null}</Button>
            <span data-file-line={index + 1} data-file-source-start={index + 1} data-file-source-end={index + 1}>{line}{index < lines.length - 1 ? '\n' : ''}</span>
          </div>)}
        </div> : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: 'var(--font-body)', lineHeight: 1.65 }}>{content}</pre>}
    </div>
    {selection && selectable ? <FileSelectionMenu items={items} text={selection.quote.text} container={container} onClose={close}
      anchor={() => selection.range.collapsed
        ? root.current!.querySelector(`[data-file-line="${selection.quote.startLine}"]`)!.parentElement!.getBoundingClientRect() : selection.range.getBoundingClientRect()}
      onCite={() => {
        void selectable.cite(citeOf(selection))
        root.current?.ownerDocument.getSelection()?.removeAllRanges()
      }}
      onSend={() => {
        if (conversation && root.current) openSendLine({ at: selection.range.getBoundingClientRect(), within: root.current, container: container ?? null, conversation, cite: citeOf(selection) })
        root.current?.ownerDocument.getSelection()?.removeAllRanges()
      }} /> : null}
  </>
}
