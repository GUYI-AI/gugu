import { composerDrafts, NEW_SESSION_DRAFT_KEY } from '@renderer/features/sessions/composer-drafts'
import type { Attachment } from '@assistant-ui/react'

type Composer = {
  getState(): { text: string; attachments?: readonly Attachment[] }
  setText(text: string): void
  subscribe(listener: () => void): () => void
  addAttachment?(file: File): Promise<void>
  clearAttachments?(): Promise<void>
}

/** The existing creation draft follows the first sentence across device choices, within one account. */
export function mobileCreationDraftKey(ownerId: string): string {
  return `${NEW_SESSION_DRAFT_KEY}:mobile:${ownerId}`
}

export function bindCreationDraft(composer: Composer, key: string) {
  let active = true
  let submitted = false
  let hydrating = false
  const stored = composerDrafts.forKey(key)
  const pending = (attachments: readonly Attachment[]) => attachments.flatMap((attachment) => attachment.file ? [{
    file: attachment.file,
    chip: { id: attachment.id, name: attachment.name, kind: attachment.type === 'image' ? 'image' as const : 'file' as const },
  }] : [])
  const hydrate = async (attachments: readonly Attachment[] | typeof stored.pending) => {
    if (!composer.addAttachment || !active) return
    const files = attachments.flatMap((entry) => entry.file ? [entry.file] : [])
      .filter((file) => !composer.getState().attachments?.some((entry) => entry.file === file))
    if (!files.length) return
    hydrating = true
    try { await Promise.all(files.map((file) => composer.addAttachment!(file))) }
    finally { hydrating = false; if (active) remember() }
  }
  if (!composer.getState().text) composer.setText(composerDrafts.get(key))
  const remember = () => {
    if (hydrating) return
    const text = composer.getState().text
    // assistant-ui clears the composer before onNew; an in-flight first sentence still belongs to this draft.
    if (!submitted || text.length > 0) composerDrafts.set(key, text)
    const attachments = composer.getState().attachments
    if (attachments && (!submitted || attachments.length > 0)) stored.setPending(pending(attachments))
  }
  const unsubscribe = composer.subscribe(remember)
  const ready = hydrate(stored.pending)
  return {
    ready,
    hold(text: string, attachments?: readonly Attachment[]) {
      submitted = true
      composerDrafts.set(key, text)
      if (attachments) stored.setPending(pending(attachments))
    },
    accepted(text: string, attachments?: readonly Attachment[]) {
      // A newer page may already have edited the shared draft while this request was in flight.
      if (composerDrafts.get(key).trim() === text.trim()) composerDrafts.set(key, '')
      if (attachments) {
        const sent = new Set(attachments.map((entry) => entry.id))
        stored.setPending(stored.pending.filter((entry) => !sent.has(entry.chip.id)))
      }
      submitted = false
    },
    async restore(text: string, attachments?: readonly Attachment[]) {
      submitted = false
      if (active && !composer.getState().text) composer.setText(text)
      if (attachments) await hydrate(attachments)
    },
    dispose() {
      remember()
      active = false
      unsubscribe()
      composer.setText('')
      void composer.clearAttachments?.()
    },
  }
}
