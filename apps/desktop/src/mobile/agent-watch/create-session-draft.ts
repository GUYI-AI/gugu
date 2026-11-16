import { composerDrafts, NEW_SESSION_DRAFT_KEY } from '@renderer/features/sessions/composer-drafts'
import type { Attachment } from '@assistant-ui/react'

type Composer = {
  getState(): { text: string; attachments?: readonly Attachment[] }
  setText(text: string): void
  subscribe(listener: () => void): () => void
  addAttachment?(file: File): Promise<void>
  clearAttachments?(): Promise<void>
}

type BindingLease = { done: boolean; settled: Promise<void> }
// A runtime may be reused by a different account. Its previous async adds must settle and be cleared first.
const composerBindings = new WeakMap<Composer, BindingLease>()

/** The existing creation draft follows the first sentence across device choices, within one account. */
export function mobileCreationDraftKey(ownerId: string): string {
  return `${NEW_SESSION_DRAFT_KEY}:mobile:${ownerId}`
}

export function bindCreationDraft(composer: Composer, key: string) {
  let active = true
  let submitted = false
  let hydrating = false
  let initialized = false
  let unsubscribe = () => {}
  let finishCleanup!: () => void
  const previous = composerBindings.get(composer)
  const lease: BindingLease = { done: false, settled: new Promise<void>((resolve) => { finishCleanup = resolve }) }
  composerBindings.set(composer, lease)
  const additions = new Set<Promise<void>>()
  const stored = composerDrafts.forKey(key)
  const pending = (attachments: readonly Attachment[]) => attachments.flatMap((attachment) => attachment.file ? [{
    file: attachment.file,
    chip: { id: attachment.id, name: attachment.name, kind: attachment.type === 'image' ? 'image' as const : 'file' as const },
  }] : [])
  const hydrate = async (attachments: readonly Attachment[] | typeof stored.pending) => {
    if (!composer.addAttachment || !active || composerBindings.get(composer) !== lease) return
    const files = attachments.flatMap((entry) => entry.file ? [entry.file] : [])
      .filter((file) => !composer.getState().attachments?.some((entry) => entry.file === file))
    if (!files.length) return
    hydrating = true
    const adding = files.map((file) => {
      const task = composer.addAttachment!(file)
      additions.add(task)
      void task.finally(() => additions.delete(task)).catch(() => {})
      return task
    })
    try { await Promise.all(adding) }
    finally { hydrating = false; if (active) remember() }
  }
  const remember = () => {
    if (hydrating || !initialized) return
    const text = composer.getState().text
    // assistant-ui clears the composer before onNew; an in-flight first sentence still belongs to this draft.
    if (!submitted || text.length > 0) composerDrafts.set(key, text)
    const attachments = composer.getState().attachments
    if (attachments && (!submitted || attachments.length > 0)) stored.setPending(pending(attachments))
  }
  const initialize = () => {
    if (!active || composerBindings.get(composer) !== lease) return
    initialized = true
    if (!composer.getState().text) composer.setText(composerDrafts.get(key))
    unsubscribe = composer.subscribe(remember)
    return hydrate(stored.pending)
  }
  const ready = previous && !previous.done ? previous.settled.then(initialize) : Promise.resolve(initialize())
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
      if (!active) return
      remember()
      active = false
      unsubscribe()
      composer.setText('')
      // clearAttachments cancels the SDK's pending additions. The second clear also protects adapters/composers
      // whose add has already escaped cancellation; no next binding subscribes before this barrier resolves.
      const clearing = composer.clearAttachments?.()
      if (!clearing && !additions.size && (!previous || previous.done)) {
        lease.done = true; finishCleanup()
      } else {
        void Promise.allSettled([ready, clearing, ...additions]).then(async () => {
          await composer.clearAttachments?.()
          lease.done = true; finishCleanup()
        })
      }
    },
  }
}
