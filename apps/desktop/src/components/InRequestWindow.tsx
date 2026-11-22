import { useState, type ReactNode } from 'react'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { requestLayer } from '@renderer/app/aux-layers'

/**
 * For an app-wide host mounted once in the main window's tree (a forward page, a confirmation, a session dialog): what it
 * opens shows in the window the request came from (aux-layers), fixed when it opens. Mount it when the popup opens.
 */
export function InRequestWindow({ children }: { children: ReactNode }) {
  const [layer] = useState(requestLayer)
  return <UiPortalContainerProvider value={layer ?? undefined}>{children}</UiPortalContainerProvider>
}
