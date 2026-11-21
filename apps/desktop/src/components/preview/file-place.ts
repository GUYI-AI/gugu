import type { FilePlace } from '@gugu/core/shared/ui/guguLink'
import { useEffect, useState } from 'react'
import { createSelectStore, patch, useSelect } from '@/lib/selectStore'

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

export function tellFilePlace(itemId: string, at: FilePlace): void {
  patch(places, itemId, { at: { ...at }, until: Date.now() + WAIT_MS })
}

/** The place last told for this chat file's preview; undefined until one is. */
export function useFilePlace(itemId: string | null): FilePlace | undefined {
  const [opened] = useState(() => Date.now())
  const told = useSelect(places, (map) => (itemId ? map.get(itemId) : undefined), Object.is)
  useEffect(() => (itemId ? () => patch(places, itemId, undefined) : undefined), [itemId])
  return told && told.until >= opened ? told.at : undefined
}
