import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

const LAYER_STYLE = { position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 'var(--z-modal)' } as const

export function SessionModalLayer({ container = document.body, children }: {
  container?: HTMLElement
  children: ReactNode
}) {
  return createPortal(<div style={LAYER_STYLE}>{children}</div>, container)
}
