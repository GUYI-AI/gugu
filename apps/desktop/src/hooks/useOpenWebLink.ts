import { useCallback, useContext } from 'react'
import { PaneContext } from '@renderer/features/tabs/pane-context'

export type WebLinkClick = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>

/** A person's web link opens beside the chat, or in a new tab beside the file they were reading. */
export function useOpenWebLink(intent: 'beside' | 'newTab' = 'beside') {
  const pane = useContext(PaneContext)?.pane
  return useCallback((href: string, click: WebLinkClick): boolean => {
    // Modified clicks keep the existing system-browser path. Non-web links keep their own openers.
    if (!pane || click.metaKey || click.ctrlKey || !/^https?:\/\//i.test(href)) return false
    pane.open('browser', { initialUrl: href }, { intent })
    return true
  }, [pane, intent])
}
