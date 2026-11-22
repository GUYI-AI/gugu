import { observer } from 'mobx-react-lite'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { peekStore } from '../../session/renderer/features/extensions/peek-store'
import { useBackLayer } from '../ui/sheetStack'
import { PeekCovered } from './peekCovered'
import { TrackCut } from '../../session/renderer/features/tabs/pane-track-cut'

// What is drawn in it, loaded when something is opened (it reaches the host's previews, frames and platform).
const AppPeek = lazy(() => import('./AppPeek').then((m) => ({ default: m.AppPeek })))

/** Wide enough for the page and what is opened beside it, side by side; narrower, it opens over the page. */
const BESIDE_MIN_WIDTH = 960

/**
 * G1 One App page's slot, and what is opened beside that page (`peekStore`, by the slot the page is drawn in). Wide, the
 * two sit side by side; narrow (a chat's panel, a phone), it opens over the page, with a way back. The page itself is never
 * moved, unmounted or given up — only hidden while covered — so it is just as it was when what was opened closes.
 */
export const AppPeekSlot = observer(function AppPeekSlot({ sessionId, tabId, chatId, narrow = false, children }: {
  sessionId: string | null;
  tabId: string;
  /** The chat the page is drawn in: what it opens beside it is that chat's too (its selection's Cite and Annotate go there). */
  chatId?: string;
  narrow?: boolean;
  children: ReactNode;
}) {
  const target = peekStore.of(sessionId, tabId)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // Measured only while something is open beside the page: a slot with nothing open costs nothing.
  const open = target !== null
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !open) return undefined
    const observer = new ResizeObserver(() => setWidth(box.getBoundingClientRect().width))
    observer.observe(box)
    return () => observer.disconnect()
  }, [open])
  const close = () => peekStore.close(sessionId, tabId)
  // What is drawn beside the page: what is open, or what was until its cell is at nothing (the cut's track lands).
  const [drawn, setDrawn] = useState(target)
  // The phone's back key (and the header's back) closes it before anything under it.
  useBackLayer(close, target !== null)
  const beside = !narrow && width >= BESIDE_MIN_WIDTH
  if (drawn !== target && (target || !beside)) setDrawn(target)
  const closing = !target && drawn !== null
  const covered = target !== null && !beside
  const peek = (over: boolean) => drawn && (
    <div className={over ? 'absolute inset-0 flex flex-col bg-[var(--bg-primary)]' : 'flex min-h-0 flex-1 flex-col'} data-testid="app-peek" data-peek-kind={drawn.kind} inert={closing || undefined}>
      <Suspense fallback={null}>
        <AppPeek target={drawn} slotKey={`${sessionId ?? ''}:${tabId}`} {...(chatId ? { chatId } : {})} beside={beside} onClose={close} />
      </Suspense>
    </div>
  )
  return (
    // Narrow (a phone), what is opened covers the panel's header too — the slot is not its containing block, the panel is:
    // one header on screen, the peek's, whose back returns to the page with its own.
    <div ref={boxRef} className={`${narrow ? '' : 'relative '}flex min-h-0 min-w-0 flex-1`} data-testid="app-peek-slot" data-peek={target ? (beside ? 'beside' : 'over') : undefined}>
      {/* Beside, what is opened comes and goes on the cut's track (max(420px, 45%) wide); the page keeps its element. */}
      <TrackCut axis="x" animate onShares={() => {}} onEqualize={() => {}} onLanded={closing ? () => setDrawn(null) : undefined}
        shares={(span) => drawn && beside ? closing ? [100, 0] : [100 - (100 * Math.max(420, 0.45 * span)) / span, (100 * Math.max(420, 0.45 * span)) / span] : [100]}
        items={[{ id: 'page', min: 0, node: <div data-peek-page className={`flex min-h-0 min-w-0 flex-1 flex-col${covered ? ' invisible' : ''}`}>
          <PeekCovered.Provider value={covered}>{children}</PeekCovered.Provider>
        </div> }, ...(drawn && beside ? [{ id: 'peek', min: 0, fixed: true, node: peek(false) }] : [])]} />
      {covered && peek(true)}
    </div>
  )
})
