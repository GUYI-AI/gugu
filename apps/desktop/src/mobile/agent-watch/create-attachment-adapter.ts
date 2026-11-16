import type { AttachmentAdapter } from '@assistant-ui/react'
import { MAX_ATTACHMENT_BYTES } from '@gugu/session-core/session-record/contract'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/** Local selection only. The creation coordinator places the original File before admitting the first turn. */
export function createAttachmentDraftAdapter(key: string): AttachmentAdapter {
  return {
    accept: '*',
    async add({ file }) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(translateSessionMessage('composer.attachmentTooLarge'))
      const retained = composerDrafts.forKey(key).pending.find((entry) => entry.file === file)
      return {
        id: retained?.chip.id ?? crypto.randomUUID(),
        type: file.type.startsWith('image/') ? 'image' : 'document',
        name: file.name,
        contentType: file.type,
        file,
        status: { type: 'requires-action', reason: 'composer-send' },
      }
    },
    // assistant-ui owns selection/removal; bindCreationDraft mirrors it, including reset and account changes.
    async remove() {},
    async send(attachment) {
      // This completes only the local adapter lifecycle, not an upload or a cloud placement.
      // AppendMessage retains file and id; no file contents are substituted into the prompt.
      return { ...attachment, status: { type: 'complete' }, content: [] }
    },
  }
}
