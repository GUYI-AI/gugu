import type { FilePlace } from '@gugu/core/shared/ui/guguLink'
import { useEffect, useState } from 'react'

/**
 * A link's place in a chat file the host previews (`#page=3` in a PDF, `#intro` in an HTML page): the preview of that
 * file already open takes it now; else the one about to open takes it when it mounts, if within a while. Each telling is
 * a new object, so the same place clicked again moves the preview again.
 */
const waiting = new Map<string, { at: FilePlace; until: number }>()
const shown = new Map<string, Set<(at: FilePlace) => void>>()
const WAIT_MS = 30_000

export function tellFilePlace(itemId: string, at: FilePlace): void {
  const previews = shown.get(itemId)
  if (previews?.size) for (const hear of previews) hear({ ...at })
  else waiting.set(itemId, { at, until: Date.now() + WAIT_MS })
}

/** The place last told for this chat file's preview; undefined until one is. */
export function useFilePlace(itemId: string | null): FilePlace | undefined {
  const [at, setAt] = useState<FilePlace>()
  useEffect(() => {
    if (!itemId) return undefined
    const first = waiting.get(itemId)
    waiting.delete(itemId)
    if (first && first.until >= Date.now()) setAt({ ...first.at })
    const previews = shown.get(itemId) ?? new Set()
    shown.set(itemId, previews.add(setAt))
    return () => {
      previews.delete(setAt)
      if (previews.size === 0) shown.delete(itemId)
    }
  }, [itemId])
  return at
}
