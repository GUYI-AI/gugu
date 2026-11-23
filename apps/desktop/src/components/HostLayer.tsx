import { useLayoutEffect, useState } from 'react'
import { HOST_LAYER_SHOW, hostLayerWindowName } from '@/session/shared/aux-window'
import { mirrorDocument } from '@/session/renderer/lib/aux-document'
import { desktopIpc } from '@/platform/desktopIpc'

type Layer = { win: Window; root: HTMLElement }
let layer: Layer | null = null

/** The window's one layer document (electron/host-layer.ts), opened on first use and kept; reopened after it was closed. */
function hostLayer(): Layer {
  if (layer && !layer.win.closed) return layer
  const win = window.open('about:blank', hostLayerWindowName())
  if (!win) throw new Error('The host layer could not be opened')
  const doc = win.document
  mirrorDocument(document, doc)
  doc.documentElement.style.background = 'transparent'
  doc.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'
  const root = doc.createElement('div')
  doc.body.append(root)
  layer = { win, root }
  return layer
}

/**
 * @@@host-layer — the single way for something drawn by this window to float above a native web page view without the
 * page stepping aside (contract: electron/host-layer.ts). While `active`, the layer covers the window and takes the
 * keyboard, and this returns the element to portal into (pass it to UiPortalContainerProvider); otherwise it is hidden.
 * `null` until the layer is ready. Without Electron there are no native views: `undefined`, and the caller draws in place.
 */
export function useHostLayer(active: boolean): HTMLElement | null | undefined {
  const native = desktopIpc() !== null
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const ipc = active ? desktopIpc() : null
    if (!ipc) return
    setRoot(hostLayer().root)
    void ipc.invoke(HOST_LAYER_SHOW, true)
    return () => {
      void ipc.invoke(HOST_LAYER_SHOW, false)
      setRoot(null)
    }
  }, [active])
  return native ? root : undefined
}
