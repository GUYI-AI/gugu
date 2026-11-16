import { expect, it } from 'vitest'
import type { Attachment } from '@assistant-ui/react'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { bindCreationDraft, mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'
import { createAttachmentDraftAdapter } from '../../../apps/desktop/src/mobile/agent-watch/create-attachment-adapter'

function composer(key: string) {
  const adapter = createAttachmentDraftAdapter(key)
  let text = '', attachments: Attachment[] = []
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }
  return {
    getState: () => ({ text, attachments }),
    setText(value: string) { text = value; changed() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async addAttachment(file: File) {
      const added = await adapter.add({ file })
      if (Symbol.asyncIterator in added) throw new Error('Expected a local selection')
      attachments = [...attachments, added]; changed()
    },
    async clearAttachments() { attachments = []; changed() },
    remove(id: string) { attachments = attachments.filter((entry) => entry.id !== id); changed() },
  }
}

it('keeps original files and stable ids across device changes and page remounts, without reading bytes', async () => {
  const key = mobileCreationDraftKey('creation-files-remount')
  const file = new File(['original bytes'], 'source.txt', { type: 'text/plain' })
  const first = composer(key), bound = bindCreationDraft(first, key)
  await first.addAttachment(file)
  const id = first.getState().attachments[0]!.id
  bound.dispose()
  const next = composer(key), rebound = bindCreationDraft(next, key)
  await rebound.ready
  expect(next.getState().attachments).toHaveLength(1)
  expect(next.getState().attachments[0]).toMatchObject({ id, file, name: 'source.txt' })
  expect(composerDrafts.forKey(key).pending[0]!.file).toBe(file)
  next.remove(id)
  expect(composerDrafts.forKey(key).pending).toEqual([])
  rebound.dispose()
})

it('restores a failed send after assistant-ui clears its attachments, without creating a second file identity', async () => {
  const key = mobileCreationDraftKey('creation-files-failure')
  const local = composer(key), bound = bindCreationDraft(local, key)
  await local.addAttachment(new File(['bytes'], 'retry.txt'))
  const sent = local.getState().attachments
  await local.clearAttachments()
  bound.hold('same task', sent)
  await bound.restore('same task', sent)
  expect(local.getState().text).toBe('same task')
  expect(local.getState().attachments[0]!.id).toBe(sent[0]!.id)
  expect(local.getState().attachments[0]!.file).toBe(sent[0]!.file)
  bound.dispose()
})

it('an old acknowledgement removes only its files and does not delete newer draft attachments', async () => {
  const key = mobileCreationDraftKey('creation-files-late-ack')
  const local = composer(key), bound = bindCreationDraft(local, key)
  await local.addAttachment(new File(['old'], 'old.txt'))
  const sent = local.getState().attachments
  await local.clearAttachments(); bound.hold('old', sent); bound.dispose()
  const next = composer(key), rebound = bindCreationDraft(next, key)
  await rebound.ready
  await next.addAttachment(new File(['new'], 'new.txt'))
  next.setText('new draft')
  bound.accepted('old', sent)
  expect(composerDrafts.forKey(key).pending.map((entry) => entry.file.name)).toEqual(['new.txt'])
  expect(next.getState().text).toBe('new draft')
  rebound.dispose()
})

it('does not restore another account’s files into a reused composer', async () => {
  const key = mobileCreationDraftKey('creation-files-owner-a')
  const local = composer(key), bound = bindCreationDraft(local, key)
  await local.addAttachment(new File(['private'], 'a.txt'))
  bound.dispose()
  const rebound = bindCreationDraft(local, mobileCreationDraftKey('creation-files-owner-b'))
  await rebound.ready
  expect(local.getState().attachments).toEqual([])
  expect(composerDrafts.forKey(key).pending).toHaveLength(1)
  rebound.dispose()
})
