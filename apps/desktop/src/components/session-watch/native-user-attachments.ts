import type { ChatCommands } from '@gugu/session-chat-ui'
import { pathAttachmentTarget } from '@gugu/session-chat-ui/markdown-attachment-mentions'

/**
 * User thumbnails read the same immutable runtime attachment, by the id the desktop uses too; a picture opens from that
 * read in the shared viewer (`openTranscriptImage`). A file opens by its path.
 */
export function nativeUserAttachmentCommands(deps: {
  readImage: (attachmentId: string) => Promise<string>
  readPathImage: (path: string) => Promise<string | null>
  openFile: (path: string) => void
}): Pick<ChatCommands, 'resolveAttachment' | 'onViewAttachment'> {
  const cached = new Map<string, Promise<string | null>>()
  const resolveAttachment: NonNullable<ChatCommands['resolveAttachment']> = attachment => {
    const ready = cached.get(attachment.id)
    if (ready) return ready
    const path = pathAttachmentTarget(attachment.id)
    const pending = (path ? deps.readPathImage(path) : deps.readImage(attachment.id)).catch(() => {
      cached.delete(attachment.id); return null
    })
    cached.set(attachment.id, pending)
    return pending
  }
  return {
    resolveAttachment,
    onViewAttachment: ({ attachment }) => {
      const path = pathAttachmentTarget(attachment.id)
      if (attachment.kind === 'file' && path) deps.openFile(path)
    },
  }
}
