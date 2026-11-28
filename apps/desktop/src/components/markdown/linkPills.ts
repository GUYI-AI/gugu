import { parseGuguLink, parseShortRef } from '@gugu/core/shared/ui/guguLink'
import type { Element, Root } from 'hast'
import { FILE_PILL_CLASS } from './filePills'

/**
 * Chat link pills: in a chat bubble, a link to a folder file, a chat or topic, one message or a session is drawn in place as the
 * file mention chip (MentionPill), as Discord draws a channel or message link. Runs after sanitizing, like the file pill
 * pass; an `@` file pill already is one.
 */
export const LINK_PILL_CLASS = 'gg-link-pill'

/** What a pill is drawn for. A session is named by its id or a prefix of it (`session:<id>`), a `msg:` prefix in its message's chat. */
export function linkPillTarget(href: string) {
  const short = parseShortRef(href)
  if (short) return short.kind === 'session' ? { kind: 'session' as const, sessionId: short.id } : { kind: 'msg' as const, prefix: short.id }
  const target = parseGuguLink(href)
  return target?.kind === 'file' || target?.kind === 'chat' || target?.kind === 'session' ? target : null
}

export function rehypeLinkPills() {
  return (tree: Root) => mark(tree)
}

function mark(parent: Root | Element): void {
  for (const node of parent.children) {
    if (node.type !== 'element') continue
    const href = node.properties?.href
    const classes = Array.isArray(node.properties?.className) ? node.properties.className : []
    if (node.tagName === 'a' && typeof href === 'string' && !classes.includes(FILE_PILL_CLASS) && linkPillTarget(href)) {
      node.properties.className = [...classes, LINK_PILL_CLASS]
      continue
    }
    mark(node)
  }
}
