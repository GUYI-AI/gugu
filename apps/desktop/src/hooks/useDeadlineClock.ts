import { useEffect, useState } from 'react'
import { serverNow } from '@gugu/core/shared/serverClock'

/**
 * Recompute once at a deadline; no deadline means no timer. The deadline and the returned `now` are on the server's
 * clock (`@@@server-clock`): both callers count from a time the backend stamped (a message's or an agent's `created_at`).
 */
export function useDeadlineClock(deadline: number | null, graceMs = 0): number {
  const [now, setNow] = useState(() => serverNow())
  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(() => setNow(serverNow()), Math.max(0, deadline - serverNow()) + graceMs)
    return () => window.clearTimeout(timer)
  }, [deadline, graceMs])
  return now
}
