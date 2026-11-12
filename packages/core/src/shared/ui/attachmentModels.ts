import { extensionOf, isImageMimeType, mimeTypeFromName, resolveAttachmentMimeType } from '../imageMime.mjs'
import type { FileMetadata, FileRef } from '../fileResolver'

export type AttachmentKind = 'image' | 'file'

/** 写进正文的那份(老式发送:字节在 chat-media,正文里带公开 URL)。 */
export interface AttachmentMeta {
  kind: AttachmentKind
  fileName: string
  mimeType: string
  url: string
  sizeBytes: number
  caption?: string
}

/**
 * 字节从哪来(附件进群文件夹 ③):
 * - url:老消息,正文里的 `[URL]`(chat-media 公开链接);
 * - item:新消息,指向群文件夹里一个条目的某一版(消息行的 file_item_id / file_version),链接经 attachments/urls 现签;
 * - message:悄悄话的附件,不进群文件夹(owner 10-17 定),消息直接指字节(file_blob_id);能读这条消息的人才签得到链接;
 * - attachment:Agent 之间交付的文件引用,通过同一文件读取器按当前账号核权取原件;
 * - session-file:agent 在任务时间线里交给主人的文件(主人通知),留在那台机器上那个会话的目录里,照那条时间线读它的方式读;
 * - gone:新消息,但条目已经删了(file_item_id 随删除置空)—— 名字还在,字节没了。
 */
export type AttachmentSource =
  | { kind: 'url'; url: string }
  | { kind: 'item'; itemId: string; version: number }
  | { kind: 'message'; messageId: string }
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'session-file'; sessionId: string | null; path: string; sha256: string }
  | { kind: 'gone' }

/** Legacy text is metadata, never an address to fetch; canonical references resolve bytes through the file reader. */
export function attachmentFileRef(source: AttachmentSource): FileRef | null {
  return source.kind === 'item' ? { item_id: source.itemId, version: source.version } : source.kind === 'message' ? { message_id: source.messageId } : source.kind === 'attachment' ? { attachment_id: source.attachmentId } : null
}

/** 读出来的附件:正文里的名字、类型、大小,加上字节从哪来。 */
export interface ParsedAttachment {
  kind: AttachmentKind
  fileName: string
  mimeType: string
  sizeBytes: number
  caption?: string
  source: AttachmentSource
  fileMetadata?: FileMetadata
  imageDimensions?: { width: number; height: number }
}

/** 消息行上指向字节的列(messages_view 的 file_item_id / file_version / file_blob_id)和消息自己的 id。 */
export interface MessageFileRef {
  id?: string | null
  file_item_id?: string | null
  file_version?: number | null
  file_blob_id?: string | null
  session_file?: { path: string; sha256: string; session_id?: string | null } | null
  local_send_state?: 'sending' | 'failed' | 'unknown' | null
  file_metadata?: FileMetadata | null
  image_dimensions?: { width: number; height: number }
}

/** 没定型的行(事件载荷、REST 原样回的 JSON)上读那两列。 */
export function messageFileRefOf(raw: { id?: unknown; file_item_id?: unknown; file_version?: unknown; file_blob_id?: unknown }): MessageFileRef {
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    file_blob_id: typeof raw.file_blob_id === 'string' ? raw.file_blob_id : null,
    file_item_id: typeof raw.file_item_id === 'string' ? raw.file_item_id : null,
    file_version: typeof raw.file_version === 'number' ? raw.file_version : null,
  }
}

const HEADER_PREFIX = '[附件] '
const URL_PREFIX = '[URL] '
const SIZE_PREFIX = '[Size] '
const KIND_PREFIX = '[Kind] '
const CAPTION_MARKER = '[Caption]'

export function formatLegacyAttachmentContent(fileName: string, mimeType: string, textContent: string): string {
  const header = `${HEADER_PREFIX}${fileName}${mimeType ? ` (${mimeType})` : ''}`
  return textContent ? `${header}\n${textContent}` : header
}

/** The body of a new attachment message, as the server writes it (`chat.attachment_envelope`): a task turn's attachment reads the same. */
export function attachmentEnvelope(fileName: string, sizeBytes: number, mimeType: string): string {
  return `${HEADER_PREFIX}${fileName}${mimeType ? ` (${mimeType})` : ''}\n${SIZE_PREFIX}${sizeBytes}\n${KIND_PREFIX}${mimeType.startsWith('image/') ? 'image' : 'file'}`
}

// @@@attachment-line-count - Voice attachment content is exactly 3 lines; media attachment content stays 4 lines so parsers can disambiguate the shared `[附件]` header.
export function formatAttachmentMetadata(meta: AttachmentMeta): string {
  const fileName = meta.fileName.trim()
  if (!fileName) throw new Error('fileName is required')
  const url = meta.url.trim()
  if (!url) throw new Error('url is required')
  const mimeType = meta.mimeType.trim()
  const sizeBytes = Math.max(0, Math.round(meta.sizeBytes))
  const kind: AttachmentKind = meta.kind === 'image' ? 'image' : 'file'
  const lines = [
    `${HEADER_PREFIX}${fileName}${mimeType ? ` (${mimeType})` : ''}`,
    `${URL_PREFIX}${url}`,
    `${SIZE_PREFIX}${sizeBytes}`,
    `${KIND_PREFIX}${kind}`,
  ]
  const caption = meta.caption?.trim()
  if (caption) lines.push(CAPTION_MARKER, caption)
  return lines.join('\n')
}

/**
 * 两种正文:老的 `[附件] / [URL] / [Size] / [Kind]`;新的(经 attachments/commit 发的)没有 `[URL]` 那一行,字节由消息行上的
 * file_item_id / file_version(群文件夹里的条目)或 file_blob_id(悄悄话,直接指字节)指着。新正文配不上指针 ⇒ 条目删了(gone)。
 */
export function parseAttachmentContent(content: string | null, ref?: MessageFileRef | null): ParsedAttachment | null {
  if (!content) return null
  const lines = content.split('\n')
  if (!lines[0]?.startsWith(HEADER_PREFIX)) return null
  const legacy = lines[1]?.startsWith(URL_PREFIX) ?? false
  const body = legacy ? lines : [lines[0], '', ...lines.slice(1)]
  if (body.length < 4) return null
  const [headerLine, urlLine, sizeLine, kindLine] = body
  if (!sizeLine.startsWith(SIZE_PREFIX) || !kindLine.startsWith(KIND_PREFIX)) return null

  const header = parseHeader(headerLine)
  if (!header) return null
  const { fileName, mimeType } = header

  let source: AttachmentSource
  if (legacy) {
    const url = urlLine.slice(URL_PREFIX.length).trim()
    if (!url) return null
    // A row this device has not delivered yet (sending, or failed with its file still here) reads its own preview.
    source = ref?.id && !((ref.local_send_state === 'sending' || ref.local_send_state === 'failed') && url.startsWith('blob:')) ? { kind: 'message', messageId: ref.id } : { kind: 'url', url }
  } else if (ref?.file_item_id && Number.isInteger(ref.file_version) && (ref.file_version as number) >= 1) {
    source = { kind: 'item', itemId: ref.file_item_id, version: ref.file_version as number }
  } else if (ref?.file_blob_id && ref.id) {
    source = { kind: 'message', messageId: ref.id }
  } else if (ref?.session_file) {
    source = { kind: 'session-file', sessionId: ref.session_file.session_id ?? null, path: ref.session_file.path, sha256: ref.session_file.sha256 }
  } else {
    source = { kind: 'gone' }
  }

  const sizeBytes = Number(sizeLine.slice(SIZE_PREFIX.length).trim())
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null

  const kindRaw = kindLine.slice(KIND_PREFIX.length).trim()
  if (kindRaw !== 'image' && kindRaw !== 'file') return null

  let caption: string | undefined
  if (body.length > 4) {
    if (body[4] !== CAPTION_MARKER) return null
    caption = body.slice(5).join('\n').trim()
    if (!caption) return null
  }

  return {
    kind: kindRaw,
    fileName,
    mimeType,
    sizeBytes: Math.round(sizeBytes),
    ...(caption ? { caption } : {}),
    source,
    ...(ref?.file_metadata ? { fileMetadata: ref.file_metadata } : {}),
    ...(ref?.image_dimensions ? { imageDimensions: ref.image_dimensions } : {}),
  }
}

function parseHeader(headerLine: string): { fileName: string; mimeType: string } | null {
  const rawHeader = headerLine.slice(HEADER_PREFIX.length).trim()
  if (!rawHeader) return null
  const headerMatch = rawHeader.match(/^(.*?)(?: \(([^()]+)\))?$/)
  const fileName = headerMatch?.[1]?.trim() ?? ''
  return fileName ? { fileName, mimeType: headerMatch?.[2]?.trim() ?? '' } : null
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 附件的 mime:文件名在那张表里有就按表(imageMime.mjs);表里没有才用浏览器给的 file.type,再没有按 resolveAttachmentMimeType 补。
 * file.type 是操作系统按后缀猜的,不是谁声明的:同一个 `.ts`,macOS 和 Electron 给 video/mp2t,Linux 给 text/vnd.trolltech.linguist。
 * 两义的后缀(TS_AMBIGUOUS)要先 `sniffFileMimeType` 看过文件头;没看过的照旧用 file.type。
 */
export function resolveFileMimeType(file: { name?: string; type?: string }): string {
  return sniffedMimeTypes.get(file) ?? (TS_AMBIGUOUS.has(extensionOf(file.name)) ? null : mimeTypeFromName(file.name))
    ?? resolveAttachmentMimeType(file.name ?? '', file.type ?? '')
}

/** 既可能是 TypeScript 源码,也可能是 MPEG-TS 视频(录屏的 .ts,AVCHD 摄像机的 .mts / .m2ts)的后缀,名字分不清。 */
const TS_AMBIGUOUS = new Set(['ts', 'mts', 'm2ts'])
const sniffedMimeTypes = new WeakMap<object, string>()

/**
 * 两义后缀的文件是不是 MPEG-TS 视频:每包以同步字节 0x47 开头,包长 188(AVCHD 的 192 字节包前面多 4 字节时间戳),
 * 连着两包对上就是。发送前定 mime 和打开时选预览都看这一处。
 */
export async function isMpegTsVideo(name: string | undefined, bytes: Blob): Promise<boolean> {
  if (!TS_AMBIGUOUS.has(extensionOf(name))) return false
  const head = new Uint8Array(await bytes.slice(0, 197).arrayBuffer())
  return (head[0] === 0x47 && head[188] === 0x47) || (head[4] === 0x47 && head[196] === 0x47)
}

/** 发送前定 mime:两义的后缀看文件头,不是视频就按表(.ts / .mts 是 TypeScript)。结果记在这个 File 上,之后 resolveFileMimeType 同步读到。 */
export async function sniffFileMimeType(file: Blob & { name?: string; type?: string }): Promise<string> {
  if (TS_AMBIGUOUS.has(extensionOf(file.name)) && !sniffedMimeTypes.has(file)) {
    sniffedMimeTypes.set(file, await isMpegTsVideo(file.name, file) ? 'video/mp2t' : mimeTypeFromName(file.name) ?? resolveAttachmentMimeType(file.name ?? '', file.type))
  }
  return resolveFileMimeType(file)
}

export function inferAttachmentKind(file: { name?: string; type?: string }): AttachmentKind {
  return isImageMimeType(resolveFileMimeType(file)) ? 'image' : 'file'
}
