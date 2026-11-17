import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentMetadata } from './attachmentBytes'
import { replica } from './replica'

/** Whether an attachment is still there (missing / expired / gone cards). Key: source key, source. */
export const attachmentState = replica({
  name: 'attachment-state',
  scope: 'account',
  read: (_accountId, _sourceKey: string, source: AttachmentSource) => attachmentMetadata(source),
  keep: 5 * 60_000,
})
