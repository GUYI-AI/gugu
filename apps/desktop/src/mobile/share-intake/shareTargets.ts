import { appendToDraft, type DraftAttachment } from '../../store/chatContext'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'

/**
 * 分享进来的内容接到那条会话已有的草稿后面:文字另起一行,附件排在已排队的后面。❌ 覆盖用户没发出去的草稿。
 */
export function mergeShareIntoDraft(
  draft: { text: string; attachments: DraftAttachment[] },
  share: { text: string | null; files: File[] },
  newId: () => string,
): { text: string; attachments: DraftAttachment[] } {
  const text = share.text ? appendToDraft(draft.text, share.text) : draft.text
  const added = share.files.map((file) => ({ id: newId(), file, kind: inferAttachmentKind(file) }))
  return { text, attachments: [...draft.attachments, ...added] }
}
