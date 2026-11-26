import { useCallback, useContext } from 'react'
import { PaneContext } from '@renderer/features/tabs/pane-context'
import { openWebLink, webLinkTarget } from '@renderer/lib/open-web-link'

export type WebLinkClick = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>

/** A person's web link opens beside the chat (or in a new tab beside the file they were reading); Cmd/Ctrl-click opens
 *  it in the system browser. Non-web links return false and keep their own openers. */
export function useOpenWebLink(intent: 'beside' | 'newTab' = 'beside') {
  const pane = useContext(PaneContext)?.pane
  return useCallback((href: string, click: WebLinkClick): boolean => openWebLink(href, webLinkTarget(click), pane, intent), [pane, intent])
}
