import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { setNoticeStripHovered } from '@/lib/notices'

/**
 * Tells lib/notices when the pointer is on a toast strip (`onHoverChange`), on the same terms sonner pauses the strip's
 * timers: over it, or pressed on it until released. A layout-free wrapper, so the strip's own styling is untouched.
 */
export function StripHover({ toasterId, children }: { toasterId: string | undefined; children: ReactNode }) {
  const state = useRef({ over: false, pressed: false })
  const report = () => setNoticeStripHovered(toasterId, state.current.over || state.current.pressed)
  useLayoutEffect(() => () => setNoticeStripHovered(toasterId, false), [toasterId])
  return (
    <div
      className="gugu-notice-strip"
      onMouseEnter={() => { state.current.over = true; report() }}
      onMouseLeave={() => { state.current.over = false; report() }}
      onPointerDown={() => { state.current.pressed = true; report() }}
      onPointerUp={() => { state.current.pressed = false; report() }}
    >
      {children}
    </div>
  )
}
