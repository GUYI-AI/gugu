import type { FilePlace } from '@gugu/core/shared/ui/guguLink'
import { useEffect, useState } from 'react'
import { createSelectStore, useSelect } from '@/lib/selectStore'

/**
 * A link's place in a chat file the host previews (`#page=3` in a PDF, `#intro` in an HTML page): the preview of that
 * file already open takes it now; else the one about to open takes it when it mounts, if within a while. Each telling is
 * a new object, so the same place clicked again moves the preview again.
 *
 * ④ transient cross-component state (a click handed to a preview), a module store: it belongs to this window, not to
 * the account, and an entry leaves when the preview that showed it goes (or is never taken after `WAIT_MS`).
 */
type Told = { at: FilePlace; until: number }
const places = createSelectStore<ReadonlyMap<string, Told>>(new Map())
const WAIT_MS = 30_000

function put(itemId: string, told: Told | null): void {
  const next = new Map(places.get())
  if (told) next.set(itemId, told)
  else if (!next.delete(itemId)) return
  places.publish(next)
  places.notify()
}

export function tellFilePlace(itemId: string, at: FilePlace): void {
  put(itemId, { at: { ...at }, until: Date.now() + WAIT_MS })
}

/** The place last told for this chat file's preview; undefined until one is. */
export function useFilePlace(itemId: string | null): FilePlace | undefined {
  // A place told longer than WAIT_MS before this preview opened is not taken.
  const [opened] = useState(() => Date.now())
  const told = useSelect(places, (map) => (itemId ? map.get(itemId) : undefined), Object.is)
  // Taken by this preview: it leaves with it, so the next preview of the file does not jump there again.
  useEffect(() => (itemId ? () => put(itemId, null) : undefined), [itemId])
  return told && told.until >= opened ? told.at : undefined
}
