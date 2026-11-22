import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { auxLayerOf } from '@renderer/app/aux-layers'

/**
 * Draw a tab's content into its pane's slot. The content belongs to the shell's tree, so its popups (menus, sheets, pickers)
 * portal where the shell's do: the main window. A slot in a pop-out window (aux-window-host) is another document; there
 * they go into that window's layer, or they open behind it in the main window.
 */
export function portalToPaneSlot(children: ReactNode, slot: HTMLElement, key: string) {
  return createPortal(<UiPortalContainerProvider value={auxLayerOf(slot.ownerDocument) ?? undefined}>{children}</UiPortalContainerProvider>, slot, key)
}
