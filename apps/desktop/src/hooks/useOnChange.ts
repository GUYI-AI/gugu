import { useEffect, useRef } from 'react'

/**
 * Runs `run(before)` after a render where `value` is no longer what the last render had (❌ on the first render): the
 * hook form of a mobx `reaction`, for a value read from a replica.
 */
export function useOnChange<T>(value: T, run: (before: T) => void): void {
  const last = useRef(value)
  useEffect(() => {
    const before = last.current
    last.current = value
    if (!Object.is(before, value)) run(before)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of `value` runs it; `run` reads this render
  }, [value])
}
