import { useState } from 'react'
import { useReplicas, type Reading, type Replica } from './replica'

/**
 * A list read a page at a time: one replica entry per page, the page's cursor its last argument (null = the first page).
 * The surface keeps only which pages it asked for; each page is a reading like any other (its own failure, its own retry).
 * Other arguments changing (another search, another tab) starts again from the first page.
 */
export function useReplicaPages<A extends unknown[], P>(
  model: Replica<[...A, string | null], P>,
  args: A | null,
  nextCursor: (page: P) => string | null | undefined,
) {
  const base = args === null ? null : JSON.stringify(args)
  const [asked, setAsked] = useState<{ base: string | null; cursors: (string | null)[] }>({ base, cursors: [null] })
  const cursors = asked.base === base ? asked.cursors : [null]
  const readings = useReplicas(model, args === null ? [] : cursors.map((cursor) => [...args, cursor] as [...A, string | null]))
  // The pages read so far, in order, up to the first not read (a later page still on its way keeps the earlier ones drawn).
  const pages: P[] = []
  for (const reading of readings) { if (reading.state !== 'value') break; pages.push(reading.value) }
  const first: Reading<P> = readings[0] ?? { state: 'unknown' }
  const last = readings.at(-1)
  const next = last?.state === 'value' ? nextCursor(last.value) ?? null : null
  return {
    /** The first page: what the list is waiting for, or why it could not be read. */
    first,
    /** Every page read, in order; empty while the first is not. */
    pages,
    /** Ask the next page; null when there is none (or the last asked is not read yet). */
    more: next !== null ? () => setAsked({ base, cursors: [...cursors, next] }) : null,
    /** A page after the first on its way. */
    loadingMore: readings.length > 1 && last?.state === 'unknown',
    /** A page after the first that could not be read, with its own retry. */
    moreFailed: readings.length > 1 && last?.state === 'error' ? last : null,
  }
}
