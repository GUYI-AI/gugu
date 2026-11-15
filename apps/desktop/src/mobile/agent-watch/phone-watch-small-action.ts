import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

/** A touch that reveals controls can retarget its compatibility click to a newly visible button. */
export function usePhoneWatchSmallAction() {
  const pressed = useRef<Element | null>(null)
  const reset = () => { pressed.current = null }
  return {
    reset,
    down: (event: PointerEvent<HTMLDivElement>) => {
      pressed.current = event.target instanceof Element ? event.target.closest('button') : null
    },
    keyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        pressed.current = event.target instanceof Element ? event.target.closest('button') : null
      }
    },
    run: (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
      // Android's first touch compatibility click may also have detail=0.
      const intended = pressed.current !== null && pressed.current === event.currentTarget
      reset()
      if (!intended) { event.preventDefault(); event.stopPropagation(); return }
      action()
    },
  }
}
