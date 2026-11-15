import { parseAttachmentContent, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'

// The files this run sent, read from this device: a sending row's own preview while its bytes upload, and the same
// file under its committed address once delivered (a video then plays from here, not from a fresh download).
// Held for this account's run only; the page reloading or the account changing forgets them.

const byMessage = new Map<string, { file: Blob; previewUrl: string | null }>()
const bySource = new Map<string, Blob>()

const keyOf = (source: AttachmentSource): string | null =>
  source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : null

/** A sending row's file and the preview URL its row draws. */
export function holdSentFile(messageId: string, file: Blob, previewUrl: string): void {
  byMessage.set(messageId, { file, previewUrl })
  bySource.set(`url:${previewUrl}`, file)
}

/** This device's copy of what a row shows, when this run sent it. A sending row's preview with no copy is a dead URL (a row restored after a restart). */
export function sentFileCopy(source: AttachmentSource): Blob | null {
  const key = keyOf(source)
  return key ? bySource.get(key) ?? null : null
}

function releasePreview(entry: { previewUrl: string | null }, forget: boolean): void {
  const url = entry.previewUrl
  if (!url) return
  entry.previewUrl = null
  // A delivered row keeps its preview's key until the committed row replaces it (a topic reads its thread back first):
  // the bytes stay readable under it, only the URL string is revoked.
  if (forget) bySource.delete(`url:${url}`)
  // The committed row draws its own source from the next frame; the old <img> must not point at a revoked URL meanwhile.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Delivered: the file stays readable under the committed row's address; the sending preview is released. */
export function adoptSentFile(messageId: string, committed: MessageItem): void {
  const entry = byMessage.get(messageId)
  if (!entry) return
  byMessage.delete(messageId)
  const source = parseAttachmentContent(committed.content, committed)?.source
  const key = source ? keyOf(source) : null
  if (key) bySource.set(key, entry.file)
  releasePreview(entry, false)
}

/** The row is gone (discarded): nothing reads its file any more. */
export function dropSentFile(messageId: string): void {
  const entry = byMessage.get(messageId)
  if (!entry) return
  byMessage.delete(messageId)
  releasePreview(entry, true)
}

/** The account's run ended. */
export function forgetSentFiles(): void {
  for (const entry of byMessage.values()) releasePreview(entry, true)
  byMessage.clear()
  bySource.clear()
}
