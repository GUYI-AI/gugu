import { attachmentEnvelope } from './ui/attachmentModels'
import { groupFileLink } from './ui/guguLink'

/**
 * What an agent reads about an attachment that is a file of its chat's folder — in a delivery, message_history and
 * message_download_file alike: which file and version it is, and how to send it again or send a changed one, so a
 * change becomes that file's next version and never a new copy.
 */
export function attachmentFolderLine(itemId: string, version: number): string {
  const file = groupFileLink(itemId, { version })
  return `[Folder file ${file} — show it again: message_send_file {file: "${file}"}; changed it: message_send_file {file: "${file}", file_path} sends your file as its next version, never as a new attachment]`
}

/**
 * Where an attachment's bytes are, for its agent: already on this computer (a path), to be fetched (the exact
 * message_download_file arguments that fetch it), or deleted.
 */
export type AttachmentWhere = { localPath: string } | { fetch: { source_message_id: string } | { file: string } } | 'gone'

/**
 * The lines after an attachment's head: the folder file, then where its bytes are. One format for an attachment message
 * delivered from a chat and a task turn's attachment (P3): an agent cannot tell which door a file came through.
 * `where` null: nothing to say (an old URL attachment, whose body carries its link).
 */
export function attachmentLocationLines(item: { itemId: string; version: number } | null, where: AttachmentWhere | null): string {
  const folder = item ? `\n${attachmentFolderLine(item.itemId, item.version)}` : ''
  if (!where) return folder
  if (where === 'gone') return `${folder}\n[Deleted: there are no bytes to fetch]`
  if ('localPath' in where) return `${folder}\n[File at local path: ${where.localPath}]`
  const [[key, value]] = Object.entries(where.fetch)
  return `${folder}\n[Not on this computer. To read or change it: message_download_file {${key}: "${value}"}]`
}

/**
 * A task turn's attachment as its agent reads it (P3) — head, folder file, and its local path or how to fetch it, as a
 * delivered attachment reads.
 */
export function turnAttachmentText(file: { itemId: string; version: number; name: string; mimeType: string; sizeBytes: number }, localPath: string | null): string {
  const head = file.mimeType.startsWith('image/') ? `[Image attached: ${file.name}]` : attachmentEnvelope(file.name, file.sizeBytes, file.mimeType)
  const where = localPath ? { localPath } : { fetch: { file: groupFileLink(file.itemId, { version: file.version }) } }
  return `${head}${attachmentLocationLines({ itemId: file.itemId, version: file.version }, where)}`
}
