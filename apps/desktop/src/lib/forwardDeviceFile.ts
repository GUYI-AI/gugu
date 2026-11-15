import type { AppForwardFilesDetail } from '../session/shared/extensions/app-runtime-protocol'
import { FORWARD_MAX_BYTES } from '../session/shared/extensions/app-runtime-protocol'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { i18n } from '../i18n'
import { attachmentBytes, attachmentMetadata } from './attachmentBytes'
import { holderOfflineText } from './fileHost'

type ForwardSource = MessageItem | Extract<AppForwardFilesDetail, { files: unknown }>['files'][number]

/**
 * A file kept on a machine has no cloud object for the target chat to refer to, so what it holds goes, as a new file.
 * Null: anything else, which goes by reference.
 */
export async function deviceFileCopy(source: ForwardSource): Promise<File | null> {
  const from: AttachmentSource | null = 'itemId' in source
    ? (source.document ? null : { kind: 'item', itemId: source.itemId, version: source.version })
    : (source.content_type === 'attachment' ? { kind: 'message', messageId: source.id } : null)
  if (!from) return null
  const file = await attachmentMetadata(from)
  if (file.status !== 'ready' || file.revision.source !== 'local') return null
  const { revision } = file
  const name = revision.file_name
  if (revision.size_bytes > FORWARD_MAX_BYTES) throw new Error(i18n.t('forward.fileTooLarge', { ns: 'messaging', name }))
  const bytes = await attachmentBytes(from).catch((error: unknown) => {
    throw revision.host_online === false ? new Error(holderOfflineText({ machine: revision.host_label?.trim() ?? '' })) : error
  })
  if (bytes.status !== 'ready') throw new Error(i18n.t('forward.fileGone', { ns: 'messaging', name }))
  return new File([bytes.blob], name, { type: revision.content_type })
}
