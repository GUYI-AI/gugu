import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { downloadAttachment } from '../../lib/attachmentBytes'

/** #2581 「下载」 on a send of several files saves each of its files, one after another. */
export async function downloadSendFiles(members: readonly MessageItem[]): Promise<void> {
  for (const member of members) {
    const file = parseAttachmentContent(member.content, member)
    if (file && file.source.kind !== 'gone') await downloadAttachment(file.source, file.fileName)
  }
}
