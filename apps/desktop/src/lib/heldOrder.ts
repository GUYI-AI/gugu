import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * While `held`, rows keep the order they had when the hold began: a row still there stays in its place, a new row goes after
 * them, a gone row leaves. Released, the live order returns in one step. For a list that re-sorts on live data (newest
 * activity first) while the person is pointing at it.
 */
export function useHeldOrder<T>(rows: readonly T[], keyOf: (row: T) => string, held: boolean): readonly T[] {
  const order = useRef<readonly string[]>([])
  if (!held) {
    order.current = rows.map(keyOf)
    return rows
  }
  const byKey = new Map(rows.map(row => [keyOf(row), row] as const))
  const kept = order.current.flatMap(key => byKey.get(key) ?? [])
  const keptKeys = new Set(order.current)
  return [...kept, ...rows.filter(row => !keptKeys.has(keyOf(row)))]
}

/** True while the pointer is over the element it is spread on and has moved within the last `restMs`; leaving, or resting that long, lets go. */
export function usePointerHold(restMs = 3000): { held: boolean; onPointerMove: (event: ReactPointerEvent) => void; onPointerLeave: () => void } {
  const [held, setHeld] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onPointerLeave = useCallback(() => { clearTimeout(timer.current); setHeld(false) }, [])
  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return
    setHeld(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(onPointerLeave, restMs)
  }, [onPointerLeave, restMs])
  return { held, onPointerMove, onPointerLeave }
}
