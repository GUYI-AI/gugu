import type { ChatCommands } from '@gugu/session-chat-ui'
import { pathAttachmentTarget } from '@gugu/session-chat-ui/markdown-attachment-mentions'

/** User thumbnails and their full-size preview read the same immutable runtime attachment, by the id the desktop uses too. */
export function nativeUserAttachmentCommands(deps: {
  readImage: (attachmentId: string) => Promise<string>
  readPathImage: (path: string) => Promise<string | null>
  openImage: (url: string, name: string, thumb?: HTMLElement) => void
  openFile: (path: string) => void
  unavailable: () => string
  onError: (error: unknown) => void
}): Pick<ChatCommands, 'resolveAttachment' | 'onViewAttachment'> {
  const cached = new Map<string, Promise<string | null>>()
  const failures = new Map<string, unknown>()
  const resolveAttachment: NonNullable<ChatCommands['resolveAttachment']> = attachment => {
    const ready = cached.get(attachment.id)
    if (ready) return ready
    const path = pathAttachmentTarget(attachment.id)
    const reading = path ? deps.readPathImage(path) : deps.readImage(attachment.id)
    const pending = reading.then(url => { failures.delete(attachment.id); return url }).catch(error => {
      cached.delete(attachment.id); failures.set(attachment.id, error); return null
    })
    cached.set(attachment.id, pending)
    return pending
  }
  return {
    resolveAttachment,
    onViewAttachment: ({ attachment, thumb }) => {
      const path = pathAttachmentTarget(attachment.id)
      if (attachment.kind === 'file' && path) { deps.openFile(path); return }
      void (attachment.dataUrl ? Promise.resolve(attachment.dataUrl) : resolveAttachment(attachment)).then(url => {
        if (!url) throw failures.get(attachment.id) ?? new Error(deps.unavailable())
        deps.openImage(url, attachment.name, thumb)
      }).catch(deps.onError)
    },
  }
}
