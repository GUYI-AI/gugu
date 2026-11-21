import { SquareArrowRight } from '@/lib/icons'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageActionItems } from './messageActionItems'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { bindFileViewerMenu } from '../preview/file-viewer-menu'
import { quoteChatFile, selectedTextQuote } from '../preview/quote-preview-file'
import { isMpegTsVideo, type AttachmentSource, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentPreview, shownAttachmentBytes, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { sentFileCopy } from '../../lib/sentFileCopies'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { rendererLogger } from '../../lib/log'
import { holderOfflineText, offlineHolder, useHolderBack, type OfflineHolder } from '../../lib/fileHost'
import { replica, useReplica } from '../../lib/replica'
import { RefreshFailed } from '../ui/RefreshFailed'
import { createSelectStore, useSelect } from '../../lib/selectStore'
import { messageForUser } from '../../lib/userFacingError'
import { useToast } from '../toastContext'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { classifyDocumentPreview } from './documentPreview'
import { savedFileName } from '../../session/shared/extensions/app-runtime-protocol'
import { chatFolderPreview } from '../preview/chat-folder-preview-registration'
import type { FileTextSelection } from '../preview/FileTextContent'
import type { HtmlPreviewRegistration } from '../preview/HtmlPreviewFrame'
import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu'
import { useFilePlace } from '../preview/file-place'
import { serverNow } from '@gugu/core/shared/serverClock'

const fileOpenLog = rendererLogger('chat/file-open')

/** 预览、下载、交给系统应用打开的那个文件:名字、类型、大小,和字节从哪来(消息附件或历史「文件」页)。 */
export type PreviewFile = Pick<ParsedAttachment, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes' | 'source'> & { document?: boolean }

/**
 * A file supplied directly by the opener, such as a workspace file or a draft attachment.
 * The opener supplies its bytes and any actions specific to its source.
 */
export interface HostedPreviewSource {
  kind: 'hosted'
  /** The bytes' identity: changing it reads them again. */
  key: string
  read: () => Promise<Blob>
  registerHtml?: (documentHtml: string) => Promise<HtmlPreviewRegistration>
  quote?: (selection: FileViewerSelection | null) => Promise<void>
  /** Its text's selection menu (FileSelectionMenu). */
  selectable?: FileTextSelection
  /** A session's HTML page takes comments on the page itself. */
  annotation?: { sessionId: string; path: string }
  /** The folders it is in, top first: one with `open` goes there. */
  folders?: readonly { name: string; open?: () => void }[]
  /** This file's source can be edited: the preview's Edit opens it there. */
  edit?: () => void
  /** The next step under a file it cannot draw, or could not read: never a dead end. */
  unreadableAction?: ReactNode
  /** Absent: this file has no address the system's programs can reach. */
  openExternal?: () => void
  /** The programs of this computer it opens in. */
  openIn?: readonly { key: string; label: string; open: () => void }[]
  download?: () => void
}
export type HostedPreviewFile = Omit<PreviewFile, 'source' | 'document'> & { source: HostedPreviewSource; document?: undefined }

type BytesOf = { source: AttachmentSource | Pick<HostedPreviewSource, 'kind' | 'key' | 'read'>; document?: boolean; mimeType: string }
type ShownBytes = { blob: Blob; acknowledged?: Promise<void> }

/**
 * 预览要读的那份字节:经 lib/attachmentBytes(签名链接 + Cache Storage);条目删了就说出来。
 * shown:先显示、后核验,`acknowledged` 失败时由显示它的预览撤下;下载不走这条。progress:读到哪了(预览的进度条)。
 */
async function previewBytes(file: BytesOf, options: { shown?: true; progress?: (done: number, total: number) => void } = {}): Promise<ShownBytes> {
  if (file.source.kind === 'hosted') return { blob: await file.source.read() }
  // A file this device sent this run is read from here: while it uploads, and after, without downloading it back.
  const sent = file.document ? null : sentFileCopy(file.source)
  if (sent) return { blob: sent }
  if (file.document && file.source.kind === 'item') {
    const { readChatFolderText } = await import('../../lib/chatFolder')
    const document = await readChatFolderText({ id: file.source.itemId })
    if (!document) throw new Error('gone')
    return { blob: new Blob([document.text], { type: file.mimeType }) }
  }
  if (options.shown) return shownAttachmentBytes(file.source, options.progress)
  const bytes = await attachmentBytes(file.source, 'full', undefined, undefined, options.progress)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  return bytes
}

/** A failed preview read, and the machine it waits for when that is why. */
class UnreadPreview extends Error {
  constructor(readonly failure: unknown, readonly holder: OfflineHolder | null) { super(failure instanceof Error ? failure.message : String(failure)) }
}
async function unreadPreview(source: BytesOf['source'], failure: unknown): Promise<UnreadPreview> {
  // A project file kept on a machine that is off now says so, from a fresh read of where it is kept.
  return new UnreadPreview(failure, source.kind === 'item' ? await offlineHolder(source.itemId, source.version) : null)
}

/** Per preview key, 0–1; owned by the read in flight (removed when it settles). Absent: not known. */
const previewProgress = createSelectStore<ReadonlyMap<string, number>>(new Map())
function noteProgress(key: string, fraction: number | null): void {
  const now = previewProgress.get()
  if (fraction === null && !now.has(key)) return
  const next = new Map(now)
  if (fraction === null) next.delete(key); else next.set(key, fraction)
  previewProgress.publish(next)
  previewProgress.notify()
}

/**
 * The bytes a preview shows: every opening reads them and the server acknowledges it (`fresh: 0`); nothing kept
 * once unshown (`keep: 0`), so a withdrawn file never keeps showing. `attempt`: read again (its machine is back).
 */
// `bytesOf` carries a hosted file's own `read` (a function): it drops out of the key's hash, which still holds the file's
// `key`, and nothing of it is kept (`keep: 0`, no `persist`). A model's arguments are data otherwise — ❌ copy this.
const previewShown = replica({
  name: 'preview-shown',
  scope: 'account',
  read: async (_owner: string, key: string, _attempt: number, file: BytesOf): Promise<ShownBytes> => {
    try {
      const bytes = await previewBytes(file, { shown: true, progress: (done, total) => { if (total > 0) noteProgress(key, done / total) } })
      bytes.acknowledged?.catch(() => undefined)
      return bytes
    } catch (error) {
      // Closed meanwhile (nobody shows it any more, its reader may have signed out): no holder read for a preview no one sees.
      if (!previewShown.isShown(key, _attempt, file)) throw error
      throw await unreadPreview(file.source, error)
    } finally {
      noteProgress(key, null)
    }
  },
  fresh: 0,
  keep: 0,
  networkMode: 'always',
  // A transient failure is read again before it is said; a machine that is off is said at once (its return reads again).
  retry: (failures: number, error: Error) => failures < 3 && transientFailure(error),
})

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges) or an object URL of its bytes when they are here; anything else, its bytes — as text for what is read as text. A
 * file gone says `gone`. The chat's preview and a peek beside an App (AppPeek) read it this one way.
 */
type PreviewRead = { content: string | ArrayBuffer | null; binary?: boolean; videoUrl?: string; expiresAt?: number; renew?: () => Promise<{ videoUrl: string; expiresAt: number }>; error?: string; retryable?: boolean; errorStatus?: 'gone' | 'expired' | 'missing' | 'failed' }
/** A failure worth reading again: not the file gone / expired / missing, and not a refusal (4xx other than timeout / rate). */
function transientFailure(error: unknown): boolean {
  if (error instanceof UnreadPreview) return !error.holder && transientFailure(error.failure)
  if (error instanceof FileReadRevokedError) return false
  if (error instanceof Error && (error.message === 'gone' || error.message === 'expired' || error.message === 'missing')) return false
  const status = (error as { status?: number } | null)?.status
  return !(status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)
}
function previewFailure(error: unknown, t: TFunction<'messaging'>): PreviewRead {
  if (error instanceof UnreadPreview) return error.holder ? { content: null, errorStatus: 'failed', error: holderOfflineText(error.holder) } : previewFailure(error.failure, t)
  if (error instanceof FileReadRevokedError && (error.reason === 'access' || error.reason === 'revision')) return { content: null, errorStatus: 'failed', error: t(error.reason === 'access' ? 'attachmentView.fileNoAccess' : 'attachmentView.fileUpdated') }
  const errorStatus = error instanceof Error && (error.message === 'gone' || error.message === 'expired' || error.message === 'missing') ? error.message : 'failed'
  return { content: null, errorStatus, retryable: transientFailure(error), error: t(errorStatus === 'gone' ? 'attachmentView.fileGone' : errorStatus === 'expired' ? 'attachmentView.fileExpired' : errorStatus === 'missing' ? 'attachmentView.fileMissing' : 'attachmentView.fileUnavailable') }
}

/** The host's preview wherever a file opens: messages, the chat's folder and an App's peek. */
export function MessageFilePreview({ file, mobile = false, fill = false, tabbed = false, readOnly = false, message, onForward, onBack, onClose }: { file: PreviewFile | HostedPreviewFile; mobile?: boolean; fill?: boolean; tabbed?: boolean; readOnly?: boolean; message?: MessageItem; onForward?: (message: MessageItem) => void; onBack?: () => void; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const kind = classifyDocumentPreview(file)
  const key = file.source.kind === 'hosted' ? file.source.key : sourceKeyOf(file.source)
  const viewerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const hostedQuote = file.source.kind === 'hosted' ? file.source.quote : undefined
    if (readOnly || !viewerRef.current || (file.source.kind !== 'item' && !hostedQuote && !message)) return
    return bindFileViewerMenu(viewerRef.current, () => ({
      resource: file.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: file.source.itemId, version: file.source.version } } : undefined,
      quote: async (selection) => {
        if (hostedQuote) return hostedQuote(selection)
        if (file.source.kind === 'item') return quoteChatFile(file.source.itemId, file.source.version, selection)
        const { UI_EVENTS } = await import('@/lib/uiEvents')
        window.dispatchEvent(new CustomEvent(UI_EVENTS.quoteMessage, { detail: { messageId: message!.id, source: message, senderName: file.fileName, content: selection ? selectedTextQuote(selection) : file.fileName } }))
      },
      canSelectAll: !(mobile && kind === 'html') && kind !== 'image' && kind !== 'video' && kind !== 'unsupported',
    }), (error) => toast(error instanceof Error ? error.message : String(error), 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source identity retains the menu snapshot across unrelated renders
  }, [key, file.fileName, message?.id, kind, mobile, toast, readOnly])
  // A chat folder's HTML document is given its folder: the files its page names beside it are shown (preview-protocol).
  const [besideOffline, setBesideOffline] = useState<{ machine: string; deviceId: string } | null>(null)
  // The machine the files beside it wait for: when the device list sees it go from off to on, the file is read again by itself.
  const [besideWaiting, setBesideWaiting] = useState<{ deviceId: string; itemId?: string; version?: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const opening = `${attempt}:${key}`
  // A video streams from its signed link unless its bytes are already here (a working copy, a file this device sent this run).
  const streamed = useMemo(() => kind === 'video' && file.source.kind !== 'hosted' && (!!file.document || !sentFileCopy(file.source)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the source's identity is its key
    [key, kind, file.document])
  const bytesOf: BytesOf = { source: file.source.kind === 'hosted' ? { kind: 'hosted', key: file.source.key, read: file.source.read } : file.source, document: file.document, mimeType: file.mimeType }
  const bytes = useReplica(previewShown, kind === 'unsupported' || streamed ? null : [key, attempt, bytesOf])
  const fraction = useSelect(previewProgress, (progress) => progress.get(key))
  const shownBytes = bytes.state === 'value' ? bytes.value : null
  const [drawn, setDrawn] = useState<{ of: ShownBytes; read: PreviewRead } | null>(null)
  useEffect(() => {
    if (!shownBytes) return
    let live = true, refused = false, release: (() => void) | undefined
    const draw = (next: PreviewRead) => { if (live) setDrawn({ of: shownBytes, read: next }) }
    const { blob, acknowledged } = shownBytes
    acknowledged?.catch((error: unknown) => { refused = true; release?.(); release = undefined; draw(previewFailure(error, t)) })
    const content = async (): Promise<PreviewRead> => {
      if (kind === 'image' || kind === 'video') {
        const url = URL.createObjectURL(blob)
        release = () => URL.revokeObjectURL(url)
        return kind === 'image' ? { content: url } : { content: null, videoUrl: url, expiresAt: Infinity }
      }
      // A `.ts` / `.mts` is TypeScript or a recording whatever its stored type; only its bytes tell.
      if (kind === 'text' && await isMpegTsVideo(file.fileName, blob)) return { content: null, binary: true }
      return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer() }
    }
    void content().then((next) => { if (!refused) draw(next) }, (error: unknown) => { if (!refused) draw(previewFailure(error, t)) })
    return () => { live = false; release?.() }
  }, [shownBytes, kind, file.fileName, t])
  const [stream, setStream] = useState<{ opening: string; read: PreviewRead; holder: OfflineHolder | null } | null>(null)
  useEffect(() => {
    if (!streamed || file.source.kind === 'hosted') return
    const source = file.source
    const at = opening
    let live = true, release: (() => Promise<void>) | undefined
    void attachmentPreview(source).then(async (preview) => {
      if (preview.status !== 'ready') throw new Error(preview.status)
      let objectUrl: string | undefined
      const renew = async () => {
        const content = await preview.content()
        if (!(content instanceof Blob)) return { videoUrl: content.url, expiresAt: content.expiresAt }
        objectUrl ??= URL.createObjectURL(content)
        return { videoUrl: objectUrl, expiresAt: Infinity }
      }
      const dispose = async () => { if (objectUrl) URL.revokeObjectURL(objectUrl); await preview.dispose() }
      try {
        const link = await renew()
        if (!live) return dispose()
        release = dispose
        setStream({ opening: at, holder: null, read: { content: null, ...link, renew } })
      } catch (error) { await dispose(); throw error }
    }).catch(async (error: unknown) => {
      const unread = await unreadPreview(source, error)
      if (live) setStream({ opening: at, holder: unread.holder, read: previewFailure(unread, t) })
    })
    return () => { live = false; void release?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the opening names the source and the attempt
  }, [opening, streamed])
  /** What this opening learnt since it drew: the file missing, or its video failing. */
  const [noted, setNoted] = useState<{ opening: string; read: PreviewRead } | null>(null)
  const read: PreviewRead | null = noted?.opening === opening ? noted.read
    : kind === 'unsupported' ? null
    : streamed ? (stream?.opening === opening ? stream.read : null)
    : bytes.state === 'unknown' ? null
    : bytes.state === 'error' ? previewFailure(bytes.error, t)
    : drawn?.of === bytes.value ? drawn.read : null
  const failedHolder = streamed ? (stream?.opening === opening ? stream.holder : null) : bytes.state === 'error' && bytes.error instanceof UnreadPreview ? bytes.error.holder : null
  useHolderBack(besideWaiting ?? failedHolder, () => { setBesideWaiting(null); setBesideOffline(null); setAttempt((n) => n + 1) })
  const itemId = file.source.kind === 'item' ? file.source.itemId : null
  const at = useFilePlace(itemId)
  const hostedHtml = file.source.kind === 'hosted' ? file.source.registerHtml : undefined
  const registerHtml = useMemo(() => {
    if (hostedHtml) return hostedHtml
    if (itemId === null) return undefined
    const style = getComputedStyle(document.documentElement)
    return chatFolderPreview(itemId, {
      unavailable: t('attachmentView.besideUnavailable'),
      outside: t('attachmentView.besideOutside'),
      offline: t('attachmentView.besideOffline'),
      palette: { surface: style.getPropertyValue('--bg-secondary').trim(), border: style.getPropertyValue('--border-strong').trim(), text: style.getPropertyValue('--text-secondary').trim() },
    }, (holder) => { setBesideOffline(holder); setBesideWaiting(holder) })
  }, [hostedHtml, itemId, t])
  const renewVideo = async (video: HTMLVideoElement) => {
    const current = read
    const at = opening
    if (video.dataset.renewing) return
    const fail = (error?: unknown) => setNoted({ opening: at, read: { ...current, ...previewFailure(error, t) } })
    // The lease's expiry is on the backend's clock (`@@@server-clock`).
    if (!current?.renew || serverNow() < (current.expiresAt ?? Infinity)) { fail(); return }
    video.dataset.renewing = 'true'
    const time = video.currentTime, playing = !video.paused
    try {
      const next = await current.renew()
      video.addEventListener('loadedmetadata', () => { video.currentTime = time; if (playing) void video.play().catch(fail) }, { once: true })
      setStream((row) => row?.read === current ? { ...row, read: { ...current, ...next } } : row)
    } catch (error) { fail(error) } finally { delete video.dataset.renewing }
  }
  const missing = read?.errorStatus === 'missing'
  const rememberMissing = (error: unknown) => {
    const failure = previewFailure(error, t)
    if (failure.errorStatus !== 'missing') return false
    setNoted({ opening, read: failure })
    return true
  }
  const savedName = savedFileName({ name: file.fileName, contentType: file.mimeType })
  const openExternal = () => {
    if (missing) return
    if (file.source.kind === 'hosted') { file.source.openExternal?.(); return }
    void openAttachmentInSystemApp(file.source, savedName).catch((error) => {
      if (rememberMissing(error)) return
      fileOpenLog.error({ error }, 'system app handoff failed')
      toast(t('chatArea.downloadFailed'), 'error', messageForUser(error))
    })
  }
  const download = () => {
    if (missing) return
    if (file.source.kind === 'hosted' && file.source.download) { file.source.download(); return }
    void previewBytes(file).then(({ blob }) => downloadBlob(blob, savedName)).catch((error) => {
      if (rememberMissing(error)) return
      fileOpenLog.error({ error }, 'preview file download failed'); toast(t('chatArea.downloadFailed'), 'error', messageForUser(error))
    })
  }
  const actions = messageActionItems({ isRetracted: !!message?.retracted_at, content: message?.content ?? null, onForward: !readOnly && message && onForward ? () => onForward(message) : undefined, onDownload: missing ? undefined : download }, t)
  if (file.source.kind === 'hosted' && !missing) for (const app of file.source.openIn ?? []) actions.push({ key: `open-in-${app.key}`, icon: SquareArrowRight, label: app.label, onSelect: app.open })
  // Read before, its read again (on reconnect) failing: the bytes drawn stay, the failure said with a retry (❌ drawn as current).
  const refreshFailed = !streamed && bytes.state === 'value' ? bytes.error : null
  const connection = besideOffline || refreshFailed ? <>
    {besideOffline ? <ConnectionStatus state="device_offline" subject={besideOffline.machine || t('attachmentView.holderMachine')} testId="message-file-preview-connection" /> : null}
    {refreshFailed ? <RefreshFailed reading={bytes} /> : null}
  </> : undefined
  // `key`: a read again (the machine back) gives the HTML preview a new registration, so its files are asked for again.
  const shown = read?.binary ? 'unsupported' : kind
  return <MessageFilePreviewPanel key={attempt} {...(file.source.kind === 'hosted' ? { folders: file.source.folders, selectable: file.source.selectable, annotation: readOnly ? undefined : file.source.annotation, unreadableAction: file.source.unreadableAction, ...(file.source.edit ? { onEdit: file.source.edit } : {}) } : {})} connection={connection} onReadAgain={read?.retryable && !failedHolder && file.source.kind !== 'hosted' ? () => setAttempt(n => n + 1) : undefined} registerHtml={registerHtml} at={at} viewerRef={viewerRef} fill={fill} tabbed={tabbed} mobile={mobile} file={file} kind={shown} content={read?.content ?? null} videoUrl={read?.videoUrl} onVideoError={renewVideo} loading={kind !== 'unsupported' && read === null} {...(fraction === undefined ? {} : { loadingFraction: fraction })} error={read?.error} onBack={onBack} onClose={onClose} actions={actions} onOpenExternal={missing || file.document || (file.source.kind === 'url' && file.source.url.startsWith('blob:')) || (file.source.kind === 'hosted' ? !file.source.openExternal : shown === 'unsupported') ? undefined : openExternal} />
}
