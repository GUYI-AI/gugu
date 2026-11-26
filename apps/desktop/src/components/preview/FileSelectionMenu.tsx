import { useLayoutEffect, useRef } from 'react'
import type { FileSelectionAction, SelectionMenuItem } from '@/session/shared/extensions/file-selection'
import { drawSelectionMenu, placeSelectionMenu } from '@/session/shared/extensions/selection-menu-dom'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'

/**
 * The host's text preview's selection menu: the same DOM an App page's runtime draws (selection-menu-dom.ts), from the
 * same table (`selectionMenu`), placed by the same rule — again as the preview scrolls, in the same frame. Copy is done
 * here; what Cite and Comment (`onSend`) do is the caller's (the conversation's composer, or its comment box).
 */
export function FileSelectionMenu({ items, text, anchor, container, onCite, onSend, onClose }: {
  items: readonly SelectionMenuItem[]
  text: string
  /** The selection's box on screen, read again as it moves. */
  anchor: () => DOMRect
  container?: HTMLElement | null
  onCite?: () => void
  onSend?: () => void
  onClose: () => void
}) {
  const latest = useRef({ text, anchor, onCite, onSend, onClose })
  latest.current = { text, anchor, onCite, onSend, onClose }
  useLayoutEffect(() => {
    const host = container ?? document.body
    const doc = host.ownerDocument
    const run = (action: FileSelectionAction) => {
      const { text: words, onCite: cite, onSend: send, onClose: close } = latest.current
      if (action === 'copy') void copyTextWithFeedback(words).catch(() => undefined)
      else (action === 'cite' ? cite : send)?.()
      close()
    }
    const menu = drawSelectionMenu(doc, items, Boolean(text), run)
    host.append(menu)
    const view = doc.defaultView!
    const place = () => {
      const at = latest.current.anchor()
      placeSelectionMenu(menu, { x: at.x, y: at.y, width: at.width, height: at.height }, { width: view.innerWidth, height: view.innerHeight })
    }
    place()
    const outside = (event: PointerEvent) => { if (!event.composedPath().includes(menu)) latest.current.onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') latest.current.onClose() }
    doc.addEventListener('scroll', place, true)
    view.addEventListener('resize', place)
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('keydown', escape, true)
    return () => {
      menu.remove()
      doc.removeEventListener('scroll', place, true)
      view.removeEventListener('resize', place)
      doc.removeEventListener('pointerdown', outside, true)
      doc.removeEventListener('keydown', escape, true)
    }
  }, [items, text, container])
  return null
}
