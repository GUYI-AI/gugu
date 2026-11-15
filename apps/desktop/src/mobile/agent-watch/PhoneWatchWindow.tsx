import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { useBackLayer } from '@/components/ui/sheetStack'
import { Expand, Minimize, MonitorSmartphone, PanelRightClose, X } from '@/lib/icons'
import { createPhoneWatchOrientation, phoneWatchCanOrient, phoneWatchIsLandscape } from '@/platform/phoneWatchOrientation'
import { fitLiveWindow } from '@/session/renderer/features/live-window/geometry'
import type { LiveWindowAction, LiveWindowPresentation, LiveWindowSource } from '@/session/renderer/features/live-window/types'
import { cornerFromPhoneDock, movePhoneWatch, phoneWatchCorner, phoneWatchDock, type PhoneWatchBox } from './phone-watch-drag'
import { usePhoneWatchZoom } from './phone-watch-zoom'
import './phone-watch-window.css'

export interface PhoneWatchSource extends LiveWindowSource {
  picture: ReactNode
}

/** Presentation only. The shared live-window model selects trusted sources and owns conversation state. */
export function PhoneWatchWindow({ children, sources, selectedId, presentation, visible, dispatch, onError }: {
  children: ReactNode
  sources: readonly PhoneWatchSource[]
  selectedId: string | null
  presentation: LiveWindowPresentation
  visible: boolean
  dispatch: (action: LiveWindowAction) => void
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation('main')
  const root = useRef<HTMLDivElement>(null)
  const chat = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<PhoneWatchBox>({ x: 0, y: 0, width: 0, height: 0 })
  const [composerHeight, setComposerHeight] = useState(0)
  const [layoutHeight, setLayoutHeight] = useState(0)
  const [landscape, setLandscape] = useState(phoneWatchIsLandscape)
  const [revealed, setRevealed] = useState(false)
  const [moving, setMoving] = useState<PhoneWatchBox | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; box: PhoneWatchBox; handle: boolean; moved: boolean; latest: PhoneWatchBox } | null>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const orientation = useRef<ReturnType<typeof createPhoneWatchOrientation> | null>(null)
  const active = visible && sources.length > 0 && presentation.mode !== 'closed'
  const large = active && presentation.mode === 'enlarged'
  const docked = active && presentation.mode === 'docked'
  const both = sources.length > 1
  const source = sources.find(item => item.id === selectedId)
  const ended = source?.status === 'finished'
  const zoom = usePhoneWatchZoom(picture, selectedId, large, source?.kind === 'computer', !ended)
  const lastError = useRef(onError)
  lastError.current = onError

  useLayoutEffect(() => {
    const host = root.current
    const body = chat.current
    if (!host || !body) return
    let composer: Element | null = null
    let viewportElement: Element | null = null
    const measure = () => {
      const box = host.getBoundingClientRect()
      setLayoutHeight(box.height)
      const nextViewport = body.querySelector('[data-chat-scroll], [data-slot="aui_thread-viewport"], [data-chat-viewport]')
      if (viewportElement !== nextViewport) { if (viewportElement) observer.unobserve(viewportElement); viewportElement = nextViewport; if (viewportElement) observer.observe(viewportElement) }
      const viewport = viewportElement?.getBoundingClientRect()
      const nextComposer = body.querySelector('[data-chat-composer-placement], [data-chat-bottom-dock]')
      if (composer !== nextComposer) { if (composer) observer.unobserve(composer); composer = nextComposer; if (composer) observer.observe(composer) }
      // Discovery ends when the real transcript and composer mount. Streaming text is not a geometry signal.
      if (composer && viewportElement) content.disconnect()
      const composerBox = composer?.getBoundingClientRect()
      const height = composerBox?.height ?? 0
      setComposerHeight(height)
      // The shared transcript scrolls behind its floating composer.
      const bottom = Math.min(viewport?.bottom ?? box.bottom, composerBox?.top ?? box.bottom)
      const next = { x: 0, y: 0, width: box.width, height: Math.max(0, bottom - box.top) }
      setArea(current => current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height ? current : next)
    }
    const observer = new ResizeObserver(measure)
    const content = new MutationObserver(measure)
    observer.observe(host); observer.observe(body)
    content.observe(body, { childList: true, subtree: true })
    measure()
    return () => { observer.disconnect(); content.disconnect() }
  }, [])

  useEffect(() => {
    const media = matchMedia('(orientation: landscape)')
    const changed = () => setLandscape(phoneWatchIsLandscape())
    media.addEventListener('change', changed)
    window.screen.orientation?.addEventListener('change', changed)
    return () => { media.removeEventListener('change', changed); window.screen.orientation?.removeEventListener('change', changed) }
  }, [])
  useEffect(() => {
    if (large) {
      if (phoneWatchCanOrient() && (presentation.orientation === 'landscape' || orientation.current)) {
        orientation.current ??= createPhoneWatchOrientation()
        void orientation.current.set(presentation.orientation ?? 'portrait').catch(error => lastError.current(error))
      }
      return
    }
    const lease = orientation.current
    orientation.current = null
    if (lease) void lease.release().catch(error => lastError.current(error))
  }, [large, presentation.orientation])
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current)
    const lease = orientation.current
    orientation.current = null
    if (lease) void lease.release().catch(error => lastError.current(error))
  }, [])
  useBackLayer(() => { dispatch({ type: 'set-orientation', orientation: 'portrait' }); dispatch({ type: 'minimize' }) }, large)

  const small = fitLiveWindow(source?.size ?? null, { width: Math.min(160, Math.max(0, area.width - 32)), height: Math.max(0, area.height - 32) })
  // A portrait picture gives the conversation room too; its composer remains at the bottom.
  const fullHeight = layoutHeight
  const enlarged = fitLiveWindow(source?.size ?? null, { width: area.width, height: Math.max(0, fullHeight - composerHeight - 96 - 48 - (both ? 32 : 0)) })
  const placed: PhoneWatchBox = { x: presentation.small.corner.endsWith('right') ? Math.max(16, area.width - (small?.width ?? 0) - 16) : 16,
    y: presentation.small.corner.startsWith('bottom') ? Math.max(16, area.height - (small?.height ?? 0) - 16) : 16,
    width: small?.width ?? 0, height: small?.height ?? 0 }
  const handle: PhoneWatchBox = { x: presentation.dock.edge === 'left' ? 0 : Math.max(0, area.width - 44),
    y: 8 + Math.max(0, area.height - 88) * presentation.dock.ratio, width: 44, height: 72 }
  const currentBox = moving ?? (docked ? handle : placed)
  const handleStyle = { left: currentBox.x, top: currentBox.y }

  const begin = (event: ReactPointerEvent<HTMLElement>, isHandle: boolean) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest('button') && !isHandle) return
    event.preventDefault()
    const box = isHandle ? handle : placed
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, box, latest: box, handle: isHandle, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = drag.current
    if (!gesture || gesture.id !== event.pointerId) return
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
    gesture.moved ||= Math.hypot(dx, dy) > 4
    if (!gesture.moved) return
    gesture.latest = movePhoneWatch(gesture.box, { x: gesture.handle ? 0 : 16, y: 8, width: area.width - (gesture.handle ? 0 : 32), height: area.height - 16 }, dx, dy)
    setMoving(gesture.latest)
  }
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = drag.current
    if (!gesture || gesture.id !== event.pointerId) return
    drag.current = null
    setMoving(null)
    if (gesture.moved) {
      dispatch(gesture.handle ? { type: 'move-dock', ...phoneWatchDock(gesture.latest, { ...area, y: 8, height: area.height - 16 }) }
        : { type: 'position', small: { corner: phoneWatchCorner(gesture.latest, area) } })
      return
    }
    if (gesture.handle) { dispatch({ type: 'position', small: { corner: cornerFromPhoneDock(presentation.dock) } }); dispatch({ type: 'undock' }); return }
    setRevealed(true)
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => setRevealed(false), 3000)
  }
  const shrink = () => { setRevealed(false); dispatch({ type: 'set-orientation', orientation: 'portrait' }); dispatch({ type: 'minimize' }) }
  const rotate = () => {
    const next = landscape ? 'portrait' : 'landscape'
    if ((presentation.orientation ?? 'portrait') === next && phoneWatchCanOrient()) {
      orientation.current ??= createPhoneWatchOrientation()
      void orientation.current.set(next).catch(onError)
    }
    dispatch({ type: 'set-orientation', orientation: next })
  }

  return <div ref={root} data-phone-watch-layout data-landscape={large && landscape || undefined}>
    <section data-phone-watch-window data-mode={large ? 'enlarged' : 'floating'} data-revealed={revealed || undefined} data-source-tabs={large && both || undefined}
      aria-label={t('controlWatch.picture')} hidden={!active || docked}
      style={large ? { width: landscape ? undefined : enlarged?.width, height: landscape ? undefined : (enlarged?.height ?? 0) + 48 + (both ? 32 : 0), visibility: landscape ? source?.size ? undefined : 'hidden' : enlarged ? undefined : 'hidden' }
        : { width: currentBox.width, height: currentBox.height, left: currentBox.x, top: currentBox.y, visibility: small ? undefined : 'hidden' }}>
      {large && <div data-phone-watch-toolbar>
        <IconButton aria-label={t('controlWatch.shrink')} onClick={shrink}><Minimize /></IconButton>
        <IconButton aria-label={t(landscape ? 'controlWatch.portrait' : 'controlWatch.landscape')} onClick={rotate}><MonitorSmartphone /></IconButton>
      </div>}
      <div ref={picture} data-phone-watch-picture {...zoom}>
        {sources.map(source => <div key={source.id} data-phone-watch-source hidden={source.id !== selectedId}
          inert={source.id !== selectedId || source.status === 'finished'}>{source.picture}</div>)}
      </div>
      {!large && <div data-phone-watch-gesture onPointerDown={event => begin(event, false)} onPointerMove={move} onPointerUp={end}
        onPointerCancel={() => { drag.current = null; setMoving(null) }}>
        <div data-phone-watch-small-actions>
          {ended ? <IconButton aria-label={t('controlWatch.close')} onClick={() => dispatch({ type: 'close' })}><X /></IconButton>
            : <IconButton aria-label={t('controlWatch.dock')} onClick={() => dispatch({ type: 'dock', ...presentation.dock })}><PanelRightClose /></IconButton>}
          <IconButton className="phone-watch-enlarge" aria-label={t('controlWatch.enlarge')} onClick={() => { setRevealed(false); dispatch({ type: 'set-orientation', orientation: 'portrait' }); dispatch({ type: 'enlarge' }) }}><Expand /></IconButton>
        </div>
      </div>}
      {large && both && <div data-phone-watch-switch role="tablist" aria-label={t('controlWatch.sources')}>
        {sources.map(source => <Button variant="ghost" size="sm" role="tab" key={source.id} aria-selected={source.id === selectedId} onClick={() => dispatch({ type: 'select-source', sourceId: source.id })}>
          {t(source.kind === 'browser' ? 'controlWatch.web' : 'controlWatch.computer')}
        </Button>)}
      </div>}
    </section>
    <div ref={chat} data-phone-watch-chat onFocusCapture={event => {
      if (large && event.target instanceof Element && event.target.closest('textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]')) shrink()
    }}>{children}</div>
    {docked && <Button variant="ghost" size="sm" data-phone-watch-handle data-edge={presentation.dock.edge} aria-label={t('controlWatch.restore')}
      style={handleStyle} onPointerDown={event => begin(event, true)} onPointerMove={move} onPointerUp={end}
      onPointerCancel={() => { drag.current = null; setMoving(null) }} onClick={event => { if (event.detail === 0) { dispatch({ type: 'position', small: { corner: cornerFromPhoneDock(presentation.dock) } }); dispatch({ type: 'undock' }) } }}>
      <span data-phone-watch-capsule>{!ended && <span data-phone-watch-active />}<span data-phone-watch-grip /></span>
    </Button>}
  </div>
}
