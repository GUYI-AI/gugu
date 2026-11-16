import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { useTranslation } from 'react-i18next'
import { sessionSend } from '@/session/renderer/features/sessions/session-send'
import { selectionSendBody, type SelectionSendResult, type SelectionSendTo } from '@/session/shared/extensions/selection-send'
import { rendererLogger } from '@/lib/log'
import { Markdown } from '../markdown/Markdown'
import { MentionPill } from '../markdown/MentionPill'
import { Button } from '../ui/Button'
import { useToast } from '../toastContext'
import { NoteEditor } from './NoteEditor'
import { useChatNote } from './useGroupMentionProvider'
import { useChatStore } from '../../store/chatContext'
import { takeSelectionSends, type SelectionSendAsked, type SelectionSendOptions } from './selectionSendAsk'
import './selection-send.css'

const log = rendererLogger('selection-send')

/** The shell's one Send box (`openSelectionSend`), as DispatchSheet is its picker: a new ask cancels the one open. */
export function SelectionSendLayer() {
  const [open, setOpen] = useState<{ asked: SelectionSendAsked; key: number } | null>(null)
  const current = useRef<SelectionSendAsked | null>(null)
  // Answered once: by the person, by running out, or by the next ask taking the box.
  const finish = useCallback((asked: SelectionSendAsked, result: SelectionSendResult) => {
    if (current.current !== asked) return
    current.current = null
    setOpen(null)
    asked.answer(result)
  }, [])
  useEffect(() => takeSelectionSends((asked) => {
    current.current?.answer('cancelled')
    current.current = asked
    setOpen(previous => ({ asked, key: (previous?.key ?? 0) + 1 }))
  }), [])
  useEffect(() => {
    if (open?.asked.closeAfterMs === undefined) return
    const timer = setTimeout(() => finish(open.asked, 'cancelled'), open.asked.closeAfterMs)
    return () => clearTimeout(timer)
  }, [open, finish])
  // On body, as DispatchSheet's Sheet portals: inside the phone's viewport shell it would sit under the file preview's sheet.
  // A page in a window of its own gets it in that window's layer, its @ list too.
  const container = open?.asked.container ?? null
  return open ? createPortal(<UiPortalContainerProvider value={container}><SelectionSendBox key={open.key} {...open.asked} done={result => finish(open.asked, result)} /></UiPortalContainerProvider>, container ?? document.body) : null
}

function SelectionSendBox({ cite, to, anchor, cover, container, done }: SelectionSendOptions & { done(result: SelectionSendResult): void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const box = useRef<HTMLDivElement>(null)
  const [words, setWords] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })
  const target = useSendTarget(to)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    if (anchor === 'dock') return setPlace({})
    const gap = 8, { innerWidth, innerHeight } = element.ownerDocument.defaultView ?? window, height = element.offsetHeight, width = element.offsetWidth
    const top = anchor.bottom + gap + height <= innerHeight ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - height)
    setPlace({ top, left: Math.max(gap, Math.min(anchor.left, innerWidth - width - gap)) })
  }, [anchor, failed])

  useLayoutEffect(() => {
    // The @ list is the editor's own popup, portaled out of the box: a pick there, or Esc closing it, is still writing.
    const at = container?.ownerDocument ?? document
    const menu = () => at.querySelector('[data-slot="composer-menu"]')
    const outside = (event: PointerEvent) => {
      const target = event.target as Element
      if (!sending && !box.current?.contains(target) && !target.closest?.('[data-slot="composer-menu"]')) done('cancelled')
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending && !menu()) { event.preventDefault(); event.stopPropagation(); done('cancelled') } }
    at.addEventListener('pointerdown', outside, true)
    at.addEventListener('keydown', key, true)
    return () => { at.removeEventListener('pointerdown', outside, true); at.removeEventListener('keydown', key, true) }
  }, [sending, done, container])

  const send = async (said = words) => {
    if (sending) return
    setSending(true)
    setFailed(false)
    try {
      await target.send(selectionSendBody(cite.draft, said), said)
      // The phone's bar covers the conversation the words went into: say they went. Beside a desktop page, it is in view.
      if (anchor === 'dock') toast(t('selectionSend.sent'), 'success')
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
      {/* The selected words as the bubble draws them (formulas too), out of their `> ` quote: at most three lines, then … */}
      {cite.quote ? <div className="gg-selection-send-quote"><Markdown trust="chat" content={cite.quote.replace(/^> ?/gm, '')} /></div> : null}
      <div className="gg-md gg-selection-send-pills">
        {cite.pills.map((label, index) => <MentionPill key={index} href="" title={label} file mention onClick={event => event.preventDefault()}>{label}</MentionPill>)}
      </div>
      <div className="gg-selection-send-note">
        <NoteEditor inputTestId="selection-send-note" placeholder={t('selectionSend.placeholder')} disabled={sending} mentionProvider={target.mentionProvider}
          renderMentionIcon={target.renderMentionIcon} onMentionInsert={target.onMentionInsert}
          enterBehavior={anchor === 'dock' ? 'newline' : 'submit'} onChange={setWords} onSubmit={(text) => void send(text)}
          inputRef={(element) => element?.focus({ preventScroll: true })} />
      </div>
      {failed ? <div role="alert" className="gg-selection-send-failure">{t('selectionSend.failed')}</div> : null}
      <div className="gg-selection-send-actions">
        <Button variant="primary" disabled={sending} onClick={() => void send()}>{t(sending ? 'selectionSend.sending' : 'selectionSend.send')}</Button>
      </div>
    </div>
  </>
}

/**
 * Where the words go and whose @ the box offers: the session composer's, sent as typed words are (54); or the chat's
 * members, sent into the chat's outbox as a forward's note is (55) — addressed by the person's own words only, never by
 * an @ inside the words they picked. Either way the box closes once the message is queued, as the composer does.
 */
function useSendTarget(to: SelectionSendTo) {
  const { chats, sendMessageToChat } = useChatStore('chats', 'sendMessageToChat')
  const chatId = 'chat' in to ? to.chat : null
  const note = useChatNote(useMemo(() => chats.find((chat) => chat.id === chatId) ?? null, [chats, chatId]))
  if (chatId) return { ...note, send: async (body: string, said: string) => { await sendMessageToChat(chatId, body, { toUserIds: note.addressed(said) }) } }
  const session = 'session' in to ? to.session : ''
  return {
    mentionProvider: sessionSend(session)?.mentionProvider, renderMentionIcon: undefined, onMentionInsert: undefined,
    send: async (body: string) => {
      const composer = sessionSend(session)
      if (!composer) throw new Error('No composer of this session is shown here')
      await composer.send(body)
    },
  }
}
