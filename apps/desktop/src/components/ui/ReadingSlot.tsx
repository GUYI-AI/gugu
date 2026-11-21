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
export function ReadingSlot<V>({ reading, placeholder, failed, className, children }: {
  reading: Reading<V>
  /** Not read yet: the classes of `<Unknown>` sized like the value, or the element that stands for it (a skeleton row). */
  placeholder?: string | ReactNode
  /** What an unreadable reading says (default: the error, for a person): a line with the retry, or an element of its own. */
  failed?: (error: Error, retry: (() => void) | undefined) => ReactNode
  /** The failure line's classes (its padding where the slot sits). */
  className?: string
  children: (value: V) => ReactNode
}) {
  if (reading.state === 'unknown') return typeof placeholder === 'string' || placeholder === undefined ? <Unknown className={placeholder} /> : <>{placeholder}</>
  if (reading.state === 'error') {
    const said = failed ? failed(reading.error, retryOf(reading)) : messageForUser(reading.error)
    return typeof said === 'string' ? <ReadFailedLine message={said} onRetry={retryOf(reading)} className={className} /> : <>{said}</>
  }
  return <>{children(reading.value)}<RefreshFailed reading={reading} /></>
}
