import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { Markdown } from '../markdown/Markdown'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { useBackLayer } from '../ui/sheetStack'
import { fileTextRange, sourceLineRange, type FileTextComment, type FileTextRange } from './file-text-range'
import './file-text-content.css'

type Selection = { range: Range; quote: FileTextRange }

/** The file's existing native selection (including touch handles) anchors an optional comment. */
export function FileTextContent({ content, kind, fileName, style, onAnnotate }: {
  content: string
  kind: 'text' | 'markdown'
  fileName: string
  style?: CSSProperties
  onAnnotate?: (comment: FileTextComment) => void | Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const container = useUiPortalContainer()
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [editing, setEditing] = useState(false)
  const [annotation, setAnnotation] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const selecting = useRef(false)
  const lineAnchor = useRef<number | null>(null)
  const dragging = useRef<number | null>(null)
  const selectedLines = useRef<Selection | null>(null)
  const lines = content.split(/\r?\n/)
  const close = () => { selectedLines.current = null; setSelection(null); setEditing(false); setAnnotation(''); setFailed(false) }
  useBackLayer(close, !!selection)

  useEffect(() => {
    const element = root.current
    if (!element || !onAnnotate || editing) return
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
  }, [content, kind, editing, onAnnotate])

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
  const save = async () => {
    if (!selection || !onAnnotate || saving) return
    setSaving(true)
    setFailed(false)
    try {
      await onAnnotate({ ...selection.quote, annotation })
      root.current?.ownerDocument.getSelection()?.removeAllRanges()
      close()
    } catch { setFailed(true) } finally { setSaving(false) }
  }
  return <>
    <div ref={root} style={style} data-file-annotations={onAnnotate ? '' : undefined}
      onPointerDown={event => {
        if (!(event.target instanceof Element) || !event.target.closest('.gg-file-line-number')) selectedLines.current = null
        if (!editing && event.button === 0) { selecting.current = true; setSelection(null) }
      }}>
      {kind === 'markdown' ? <Markdown trust="chat" density="comfortable" content={content} hardBreaks sourceLines={!!onAnnotate} />
        : onAnnotate ? <div className="gg-file-source">
          {lines.map((line, index) => <div className="gg-file-source-row" key={index}>
            <Button variant="ghost" size="sm" className="gg-file-line-number" data-line={index + 1}
              aria-label={t('fileAnnotation.selectLine', { line: index + 1 })}
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
    {selection && onAnnotate ? <Popover.Root open modal={false} onOpenChange={open => { if (!open && !saving) close() }}>
      <Popover.Portal container={container}>
        <Popover.Positioner positionMethod="fixed" anchor={{ contextElement: root.current ?? undefined, getBoundingClientRect: () => selection.range.collapsed
          ? root.current!.querySelector(`[data-file-line="${selection.quote.startLine}"]`)!.parentElement!.getBoundingClientRect() : selection.range.getBoundingClientRect() }}
          side="bottom" align="start" sideOffset={8} collisionPadding={8} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}>
          <Popover.Popup initialFocus={editing ? undefined : false} finalFocus={false} data-occludes-browser-page
            className="gg-file-annotation-popup" aria-label={t(editing ? 'fileAnnotation.comment' : 'fileAnnotation.addToChat')}>
            {!editing ? <Button variant="ghost" size="md" onPointerDown={event => event.preventDefault()} onClick={() => setEditing(true)}>{t('fileAnnotation.addToChat')}</Button>
              : <form className="gg-file-annotation-form" onSubmit={event => { event.preventDefault(); void save() }}>
                <div className="gg-file-annotation-title">{fileName} · {t(selection.quote.startLine === selection.quote.endLine ? 'fileAnnotation.line' : 'fileAnnotation.lines', { start: selection.quote.startLine, end: selection.quote.endLine })}</div>
                <textarea autoFocus aria-label={t('fileAnnotation.optionalComment')} placeholder={t('fileAnnotation.optionalComment')}
                  value={annotation} disabled={saving} rows={3} onChange={event => setAnnotation(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save() } }} />
                {failed ? <div role="alert">{t('fileAnnotation.failed')}</div> : null}
                <div className="gg-file-annotation-actions"><Button variant="ghost" size="md" disabled={saving} onClick={close}>{t('common.cancel')}</Button><Button type="submit" size="md" disabled={saving}>{t('fileAnnotation.comment')}</Button></div>
              </form>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root> : null}
  </>
}
