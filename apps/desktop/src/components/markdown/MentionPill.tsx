import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { fileLabelParts } from '@gugu/session-shared/markdown'
import { FileMark } from '@gugu/session-ui/file-mark'
import { FILE_PILL_CLASS } from './filePills'

/**
 * The chat's file mention chip (App 引用 pill), drawn for a link: a group file's `@` pill, and a file, topic or message
 * link drawn in place (linkPills.ts). `file` names the file, for its family glyph; a label that is plain text is cut as
 * the task page cuts it (`fileLabelParts`), so a long name gives way and its place stays whole. `mention` marks the `@`
 * pill, which copies back as one (hookFilePillCopy) where a link pill copies as its words; a link the reader cannot
 * open is drawn greyed.
 */
export function MentionPill({ href, title, file, icon, mention, unavailable, onClick, children, rest }: {
  href: string
  title?: string
  file?: string
  /** The kind's line mark, drawn where a file's mark goes (LinkPill's marks). */
  icon?: ReactNode
  mention?: boolean
  unavailable?: boolean
  onClick: (event: MouseEvent) => void
  children: ReactNode
  rest?: Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'title' | 'onClick' | 'children' | 'className'>
}) {
  const { name, place } = file !== undefined && typeof children === 'string' ? fileLabelParts(children) : { name: children, place: '' }
  return (
    <a {...rest} data-pane-opener="" className={`gg-md-mention ${FILE_PILL_CLASS}`} data-mention-kind={mention ? 'file' : 'link'} data-unavailable={unavailable ? 'true' : undefined}
      href={href} title={title} onClick={onClick}>
      {file !== undefined ? <span className="gg-md-mention-icon" aria-hidden="true"><FileMark name={fileLabelParts(file).name} size={12} /></span>
        : icon ? <span className="gg-md-mention-icon" aria-hidden="true">{icon}</span> : null}
      <span className="gg-md-mention-label">{name}</span>
      {place ? <span className="gg-md-mention-place">{place}</span> : null}
    </a>
  )
}
