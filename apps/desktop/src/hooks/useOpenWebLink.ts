import { useCallback, useContext } from 'react'
import { PaneContext } from '@renderer/features/tabs/pane-context'
import { openWebLink, webLinkTarget } from '@renderer/lib/open-web-link'

export type WebLinkClick = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>

/** A person's web link opens beside the chat, or in a new tab beside the file they were reading (@@@open-web-link).
 *  Only that is claimed: a Cmd/Ctrl-click, or a link with no pane around it, keeps the anchor's own `target=_blank`, which
 *  each platform sends to its system browser (the desktop main window's opener, a phone's or a web page's own tab). */
export function useOpenWebLink(intent: 'beside' | 'newTab' = 'beside') {
  const pane = useContext(PaneContext)?.pane
  return useCallback((href: string, click: WebLinkClick): boolean =>
    !!pane && webLinkTarget(click) === 'app' && openWebLink(href, 'app', pane, intent), [pane, intent])
}
