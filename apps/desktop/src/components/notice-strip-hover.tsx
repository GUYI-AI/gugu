import { useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { setNoticeStripHovered } from '@/lib/notices'

/**
 * Tells lib/notices when the pointer is on a toast strip (`onHoverChange`), on the same terms sonner pauses the strip's
 * timers: over it, or pressed on it until released. A layout-free wrapper, so the strip's own styling is untouched.
 * A press ends wherever it is released or cancelled: pressed on the strip, dragged off and let go elsewhere, the strip
 * never hears that pointerup — so the release is heard on the window, or the press (and every countdown it pauses,
 * such as an undo window) would hold forever.
 */
export function StripHover({ toasterId, children }: { toasterId: string | undefined; children: ReactNode }) {
  const state = useRef({ over: false, pressed: false })
  /** Takes the current press's window listeners off; null = not pressed. */
  const endPress = useRef<(() => void) | null>(null)
  const report = () => setNoticeStripHovered(toasterId, state.current.over || state.current.pressed)
  useLayoutEffect(
    () => () => {
      endPress.current?.()
      state.current.pressed = false
      setNoticeStripHovered(toasterId, false)
    },
    [toasterId]
  )
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    state.current.pressed = true
    report()
    if (endPress.current) return
    const view = event.currentTarget.ownerDocument.defaultView ?? window
    const released = () => {
      endPress.current?.()
      state.current.pressed = false
      report()
    }
    view.addEventListener('pointerup', released, true)
    view.addEventListener('pointercancel', released, true)
    endPress.current = () => {
      view.removeEventListener('pointerup', released, true)
      view.removeEventListener('pointercancel', released, true)
      endPress.current = null
    }
  }
  return (
    <div
      className="gugu-notice-strip"
      onMouseEnter={() => { state.current.over = true; report() }}
      onMouseLeave={() => { state.current.over = false; report() }}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  )
}
