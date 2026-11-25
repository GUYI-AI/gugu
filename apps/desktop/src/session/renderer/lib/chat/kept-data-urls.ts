/**
 * Pictures a task page drew from data URLs, kept so a row drawn again (its turn committing, its session shown again) has
 * its picture in its first frame instead of reading it anew. A data URL is the whole image as a string on the JS heap,
 * so they are kept by size: past DATA_URL_KEEP_CHARS the least recently drawn go first (the bytes stay where they were
 * read from). A read still on its way stays; a read that fails or finds nothing is not kept.
 */
export const DATA_URL_KEEP_CHARS = 32 * 1024 ** 2

type Kept = { read: Promise<string | null>; size?: number }
const kept = new Map<string, Kept>()

/** The picture under `key`: the one kept, or `read()` started once and kept. */
export function keptDataUrl(key: string, read: () => Promise<string | null>): Promise<string | null> {
  const known = kept.get(key)
  if (known) {
    touch(key, known)
    return known.read
  }
  const entry: Kept = { read: read() }
  kept.set(key, entry)
  const drop = () => { if (kept.get(key) === entry) kept.delete(key) }
  entry.read.then(url => {
    if (!url) return drop()
    if (kept.get(key) !== entry) return
    entry.size = url.length
    touch(key, entry)
  }, drop)
  return entry.read
}

function touch(key: string, entry: Kept) {
  kept.delete(key)
  kept.set(key, entry)
  let total = 0
  for (const { size } of kept.values()) total += size ?? 0
  for (const [held, { size }] of kept) {
    if (total <= DATA_URL_KEEP_CHARS) break
    if (size === undefined) continue
    kept.delete(held)
    total -= size
  }
}

/** Tests only: start from nothing kept. */
export function forgetKeptDataUrls(): void { kept.clear() }
