import { isWebLink } from '@/session/shared/link-menu'
import { openWebLink } from '@renderer/lib/open-web-link'
export { selectLinkForMenu } from '@/lib/selectLinkForMenu'

/** The link rows of a message's menu (@@@link-menu) for the link under the pointer: its own click (Gugu's browser for a web
 *  link), the system browser, copy. No link ⇒ no rows. */
export function messageLinkActions(link: HTMLAnchorElement | null, copy: (text: string) => void, close: () => void) {
  if (!link) return {}
  return {
    onOpenLink: () => { link.click(); close() },
    onOpenLinkSystem: isWebLink(link.href) ? () => { openWebLink(link.href, 'system'); close() } : undefined,
    onCopyLink: () => { copy(link.href); close() },
  }
}
