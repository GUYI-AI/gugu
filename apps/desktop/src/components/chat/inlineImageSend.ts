import { inlineImageParts } from '@gugu/session-ui/react/components'

export type InlineImageRun = { size: number; caption?: string }
/**
 * A chat message with pictures placed in its words, as the rows it is sent as. The order is kept without a new message
 * shape: the words before the first picture are a text message, then each run of adjacent pictures (only whitespace
 * between them) is one send (an album) whose caption is the words that follow it, up to the next picture. All the runs
 * go in one batch, so their rows commit in this order. Files that are not in the words (a document, a comment's
 * screenshot) ride on the last run.
 */
export type InlineImageSend = { lead: string; afterLead: string; files: File[]; runs: InlineImageRun[] }

export function planInlineImageSend(typed: string, attachments: readonly { id: string; file: File }[], extra: readonly File[]): InlineImageSend | null {
  const parts = inlineImageParts(typed)
  if (!parts.some((part) => 'imageId' in part)) return null
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment.file]))
  const placed = new Set<string>()
  const runs: Array<{ files: File[]; caption: string }> = []
  let lead = ''
  let afterLead = ''
  for (const part of parts) {
    if ('text' in part) {
      if (runs.length === 0) lead += part.text
      else runs[runs.length - 1].caption += part.text
      continue
    }
    const file = byId.get(part.imageId)
    // A picture the composer no longer holds (or one pasted twice) has nothing more to send.
    if (!file || placed.has(part.imageId)) continue
    placed.add(part.imageId)
    if (runs.length === 0) afterLead = typed.slice(typed.indexOf(`(gugu-attachment:${part.imageId})`) - '![image]'.length)
    const last = runs.at(-1)
    if (last && !last.caption.trim()) last.files.push(file)
    else runs.push({ files: [file], caption: '' })
  }
  const rest = [...attachments.filter((attachment) => !placed.has(attachment.id)).map((attachment) => attachment.file), ...extra]
  if (rest.length) {
    if (runs.length) runs[runs.length - 1].files.push(...rest)
    else { runs.push({ files: rest, caption: lead }); lead = '' }
  }
  return {
    lead: lead.trim(),
    afterLead,
    files: runs.flatMap((run) => run.files),
    runs: runs.map((run) => ({ size: run.files.length, ...(run.caption.trim() ? { caption: run.caption.trim() } : {}) })),
  }
}
