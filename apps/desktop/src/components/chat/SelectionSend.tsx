import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionSend } from '@/session/renderer/features/sessions/session-send'
import { selectionSendBody, type SelectionSendResult } from '@/session/shared/extensions/selection-send'
import { rendererLogger } from '@/lib/log'
import { Markdown } from '../markdown/Markdown'
import { MentionPill } from '../markdown/MentionPill'
import { Button } from '../ui/Button'
import { NoteEditor } from './NoteEditor'
import './selection-send.css'

export interface SelectionSendOptions {
  /** The selection's words and pills as `fileCiteDraft` writes them: shown, then sent before the person's words. */
  draft: string
  sessionId: string
  /** Beside the selection (this window's CSS px), or a bar at the bottom (phone). */
  anchor: DOMRect | 'dock'
  /** The page under the selection: a click or a wheel on it closes Send (it cannot scroll away under the box). */
  cover?: DOMRect
}

const log = rendererLogger('selection-send')
/** One `@[label](target)` of `fileCiteDraft`'s pill line (stringifyMention's bracket form). */
const PILL = /@\[((?:\\.|[^\]\\])*)\]\((?:<([^>]*)>|([^)\s]*))\)/g

export function SelectionSendBox({ draft, sessionId, anchor, cover, done }: SelectionSendOptions & { done(result: SelectionSendResult): void }) {
  const { t } = useTranslation('messaging')
  const box = useRef<HTMLDivElement>(null)
  const quote = useRef<HTMLDivElement>(null)
  const [words, setWords] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })
  const [clipped, setClipped] = useState(false)
  const mentionProvider = sessionSend(sessionId)?.mentionProvider
  // `fileCiteDraft` ends with its pills' one line: the words above it are what may be cut, never the pills.
  const cut = draft.lastIndexOf('\n')

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    setClipped(!!quote.current && quote.current.scrollHeight > quote.current.clientHeight + 1)
    if (anchor === 'dock') return setPlace({})
    const gap = 8, { innerWidth, innerHeight } = window, height = element.offsetHeight, width = element.offsetWidth
    const top = anchor.bottom + gap + height <= innerHeight ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - height)
    setPlace({ top, left: Math.max(gap, Math.min(anchor.left, innerWidth - width - gap)) })
  }, [anchor, failed])

  useLayoutEffect(() => {
    // The @ list is the editor's own popup, portaled out of the box: a pick there, or Esc closing it, is still writing.
    const menu = () => document.querySelector('[data-slot="composer-menu"]')
    const outside = (event: PointerEvent) => {
      const target = event.target as Element
      if (!sending && !box.current?.contains(target) && !target.closest?.('[data-slot="composer-menu"]')) done('cancelled')
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending && !menu()) { event.preventDefault(); event.stopPropagation(); done('cancelled') } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true) }
  }, [sending, done])

  const send = async (said = words) => {
    if (sending) return
    const target = sessionSend(sessionId)
    setSending(true)
    setFailed(false)
    try {
      if (!target) throw new Error('No composer of this session is shown here')
      await target.send(selectionSendBody(draft, said))
      done('sent')
    } catch (error) {
      log.warn({ error: String(error) }, 'Selection send failed')
      setFailed(true)
      setSending(false)
    }
  }

  return <>
    {cover || anchor === 'dock' ? <div className="gg-selection-send-cover" data-dock={anchor === 'dock' || undefined}
      style={anchor === 'dock' || !cover ? undefined : { left: cover.left, top: cover.top, width: cover.width, height: cover.height }}
      onWheel={() => done('cancelled')} /> : null}
    <div ref={box} role="dialog" aria-label={t('selectionSend.label')} className="gg-selection-send" data-dock={anchor === 'dock' || undefined}
      data-occludes-browser-page style={place}>
      {cut > 0 ? <div ref={quote} className="gg-selection-send-quote" data-clipped={clipped || undefined}>
        <Markdown trust="chat" content={draft.slice(0, cut)} />
      </div> : null}
      <div className="gg-md gg-selection-send-pills">
        {[...draft.slice(cut + 1).matchAll(PILL)].map(([, label, wrapped, bare], index) => {
          const name = label!.replace(/\\(.)/g, '$1')
          return <MentionPill key={index} href={wrapped ?? bare ?? ''} title={name} file mention onClick={event => event.preventDefault()}>{name}</MentionPill>
        })}
      </div>
      <div className="gg-selection-send-note">
        <NoteEditor inputTestId="selection-send-note" placeholder={t('selectionSend.placeholder')} disabled={sending} mentionProvider={mentionProvider}
          enterBehavior={anchor === 'dock' ? 'newline' : 'submit'} onChange={setWords} onSubmit={(text) => void send(text)}
          inputRef={(element) => element?.focus({ preventScroll: true })} />
      </div>
      {failed ? <div role="alert" className="gg-selection-send-failure">{t('selectionSend.failed')}</div> : null}
      <div className="gg-selection-send-actions">
        <Button variant="primary" size="sm" disabled={sending} onClick={() => void send()}>{t(sending ? 'selectionSend.sending' : 'selectionSend.send')}</Button>
      </div>
    </div>
  </>
}
