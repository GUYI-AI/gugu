import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// @@@modal-surface (#3857): the global store is for requests from outside any overlay (a command, a reaction, a plain
// function such as confirmDanger), so when no host redirected it, it opens above every sheet — Settings, a page modal,
// Contacts (PAGE_MODAL_FRAME, --z-settings). On --z-modal it opened under them: 「弹窗被遮住了没法选」.
const LAYER_STYLE = { position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 'var(--z-settings-modal)' } as const

export function SessionModalLayer({ container = document.body, children }: {
  container?: HTMLElement
  children: ReactNode
}) {
  return createPortal(<div style={LAYER_STYLE}>{children}</div>, container)
}
