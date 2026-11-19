// Owner 2026-11-15/16: a session id, Agent ID or message id may be written as its first 8 or more characters. This is the
// one matcher every entry uses; each entry only supplies the rows the caller can see (its sessions, a chat's messages).
// The full id is what goes on: envelopes, stored fields and sends never carry the short form.

/** The shortest prefix an id is looked up by. */
export const MIN_ID_PREFIX = 8
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A full UUID, or anything under 8 characters, is not a prefix: the exact paths judge it as written. */
export function isIdPrefix(id: string): boolean {
  return id.length >= MIN_ID_PREFIX && !FULL_UUID.test(id)
}

/**
 * The UUIDs a prefix names, as an inclusive range (`gte` / `lte` on a uuid column is an index range; a uuid has no `like`).
 * null: not a prefix (isIdPrefix), or not the start of a UUID — a stored message id may be opaque text, taken as written.
 */
export function uuidPrefixRange(prefix: string): { lo: string; hi: string } | null {
  if (!isIdPrefix(prefix)) return null
  const lower = prefix.toLowerCase()
  const hex = lower.replace(/-/g, '')
  if (!/^[0-9a-f]*$/.test(hex) || hex.length > 32) return null
  const shape = (digits: string) => `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
  const lo = shape(hex.padEnd(32, '0'))
  // A hyphen written in the wrong place names nothing.
  if (!lo.startsWith(lower)) return null
  return { lo, hi: shape(hex.padEnd(32, 'f')) }
}

export type PrefixMatch<R> = {
  /** `session` / `aid` / `msg`: how the id is written back in messages. */
  kind: string
  id: string
  rows: readonly R[]
  keyOf: (row: R) => string | null
  /** One candidate as the refusal lists it, in parentheses after its typed id. */
  describe?: (row: R) => string
  /** What the rows were: `sessions`, `messages`. */
  noun: string
  /** Said when nothing matches; the not-found fact comes first. */
  notFound: (address: string) => string
  /** Appended to the several-match refusal (`; nothing was sent`). */
  tail?: string
}

/** The rows an id names, keyed by their full id: the exact one alone, else every row whose id it prefixes. */
export function idPrefixMatches<R>(id: string, rows: readonly R[], keyOf: (row: R) => string | null): Array<[string, R]> {
  const wanted = id.toLowerCase()
  const exact = rows.find((row) => keyOf(row)?.toLowerCase() === wanted)
  if (exact) return [[keyOf(exact)!, exact]]
  return [...new Map(rows.flatMap((row) => {
    const key = keyOf(row)
    return key && key.toLowerCase().startsWith(wanted) ? [[key, row] as const] : []
  })).entries()]
}

/** One id → its full form: exact match, else the one row it prefixes; several are refused with the candidates, none says so. */
export function matchIdPrefix<R>({ kind, id, rows, keyOf, describe, noun, notFound, tail = '' }: PrefixMatch<R>): string {
  const address = `${kind}:${id}`
  const matches = idPrefixMatches(id, rows, keyOf)
  if (matches.length === 1) return matches[0]![0]
  if (matches.length > 1) {
    const shown = matches.slice(0, 10).map(([key, row]) => `${kind}:${key}${describe ? ` (${describe(row)})` : ''}`).join(', ')
    throw new Error(`${address} matches ${matches.length} ${noun}: ${shown}${matches.length > 10 ? ', …' : ''}. Pass a longer prefix or the full id${tail}`)
  }
  throw new Error(notFound(address))
}
