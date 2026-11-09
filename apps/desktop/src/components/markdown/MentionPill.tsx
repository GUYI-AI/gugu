import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { FILE_PILL_CLASS } from './filePills'

const FILE_ICON = (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" />
    <polyline points="9 2 9 6 13 6" />
  </svg>
)

/**
 * The chat's file mention chip (App 引用 pill), drawn for a link: a group file's `@` pill, and a file, topic or message
 * link drawn in place (linkPills.ts). `file` gives it the file glyph; `mention` marks the `@` pill, which copies back as
 * one (hookFilePillCopy) where a link pill copies as its words; a link the reader cannot open is drawn greyed.
 */
export function MentionPill({ href, title, file, mention, unavailable, onClick, children, rest }: {
  href: string
  title: string
  file?: boolean
  mention?: boolean
  unavailable?: boolean
  onClick: (event: MouseEvent) => void
  children: ReactNode
  rest?: Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'title' | 'onClick' | 'children' | 'className'>
}) {
  return (
    <a {...rest} className={`gg-md-mention ${FILE_PILL_CLASS}`} data-mention-kind={mention ? 'file' : 'link'} data-unavailable={unavailable ? 'true' : undefined}
      href={href} title={title} onClick={onClick}>
      {file ? <span className="gg-md-mention-icon" aria-hidden="true">{FILE_ICON}</span> : null}
      <span className="gg-file-pill-label">{children}</span>
    </a>
  )
}
