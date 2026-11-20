import type { ReactNode } from 'react'
import { messageForUser } from '../../lib/userFacingError'
import { retryOf, type Reading } from '../../lib/replica'
import { ReadFailedLine } from '../../session/renderer/lib/ui/read-failed-line'
import { RefreshFailed } from './RefreshFailed'
import { Unknown } from './Unknown'

/**
 * @@@reading-slot — where a reading's value goes, drawn in its three states (lib/replica): not read yet, the neutral
 * placeholder the value's size (`placeholder`, the classes of `<Unknown>`); unreadable, the failure said there with the
 * reading's own retry; read, `children(value)`, and a refresh that failed over it said below with the same retry.
 * The one place a surface's three states are drawn: ❌ a hand-written branch per surface with its own 「重试」.
 */
export function ReadingSlot<V>({ reading, placeholder, failed, children }: {
  reading: Reading<V>
  placeholder?: string
  /** What an unreadable reading says (default: the error, for a person). */
  failed?: (error: Error) => string
  children: (value: V) => ReactNode
}) {
  if (reading.state === 'unknown') return <Unknown className={placeholder} />
  if (reading.state === 'error') {
    return <ReadFailedLine message={failed ? failed(reading.error) : messageForUser(reading.error)} onRetry={retryOf(reading)} />
  }
  return <>{children(reading.value)}<RefreshFailed reading={reading} /></>
}
