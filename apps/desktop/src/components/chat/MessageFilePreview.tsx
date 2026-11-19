import { SquareArrowRight } from '@/lib/icons'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageActionItems } from './messageActionItems'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { queryClient } from '../../lib/replica'
import { bindFileViewerMenu } from '../preview/file-viewer-menu'
import { quoteChatFile, selectedTextQuote } from '../preview/quote-preview-file'
import { attachmentFileRef, isMpegTsVideo, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { FileReadError, type FileReadState } from '@gugu/core/shared/fileReads'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentPreview, downloadAttachment, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { sentFileCopy } from '../../lib/sentFileCopies'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { rendererLogger } from '../../lib/log'
import { holderOfflineText, offlineHolder, useHolderBack } from '../../lib/fileHost'
import { messageForUser } from '../../lib/userFacingError'
import { fileReadFailure, fileReadProgress, type ReadProgress } from '../../lib/fileReadStatus'
import { useToast } from '../toastContext'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { classifyDocumentPreview, documentPreviewNeedsFetch, type DocumentPreviewKind } from './documentPreview'
import { savedFileName } from '../../session/shared/extensions/app-runtime-protocol'
import { chatFolderPreview } from '../preview/chat-folder-preview-registration'
import type { FileAnnotationContext } from '../preview/FilePreviewAnnotations'
import type { HtmlPreviewRegistration } from '../preview/HtmlPreviewFrame'
import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu'
import { useFilePlace } from '../preview/file-place'

const fileOpenLog = rendererLogger('chat/file-open')

/** 预览、下载、交给系统应用打开的那个文件:名字、类型、大小,和字节从哪来(消息附件或历史「文件」页)。 */
export type PreviewFile = Pick<ParsedAttachment, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes' | 'source'> & { document?: boolean }

/**
 * A file the chat's file service does not hold (a session's working copy, on this computer or another): the same preview,
 * with its bytes and what it can do said by whoever opened it.
 */
export interface HostedPreviewSource {
  kind: 'hosted'
  /** The bytes' identity: changing it reads them again. */
  key: string
  read: () => Promise<Blob>
  registerHtml: (documentHtml: string) => Promise<HtmlPreviewRegistration>
  quote: (selection: FileViewerSelection | null) => Promise<void>
  /** Its text preview offers Cite on a selection (a session's file): `quote` with that selection. */
  citesSelection?: boolean
  annotation?: FileAnnotationContext
  /** Its text preview offers Send on a selection too (`openSelectionSend`, beside it). */
  send?: (selection: FileViewerSelection, at: DOMRect) => void
  /** The folders it is in, top first: one with `open` goes there. */
  folders?: readonly { name: string; open?: () => void }[]
  /** This file's source can be edited: the preview's Edit opens it there. */
  edit?: () => void
  /** The next step under a file it cannot draw, or could not read: never a dead end. */
  unreadableAction: ReactNode
  /** Absent: this file has no address the system's programs can reach. */
  openExternal?: () => void
  /** The programs of this computer it opens in. */
  openIn?: readonly { key: string; label: string; open: () => void }[]
  download: () => void
}
export type HostedPreviewFile = Omit<PreviewFile, 'source' | 'document'> & { source: HostedPreviewSource; document?: undefined }

/**
 * A preview can show a file before acknowledgement and take it down if acknowledgement fails.
 */
async function previewBytes(file: PreviewFile | HostedPreviewFile, options?: { signal: AbortSignal; onState: (state: FileReadState) => void }): Promise<{ blob: Blob; acknowledged?: Promise<void> }> {
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
  const bytes = await attachmentBytes(file.source, options ? 'shown' : 'full', undefined, undefined, options)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  return bytes
}

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges); anything else, its bytes — as text for what is read as text. A file gone throws `gone`. The chat's preview and
 * a peek beside an App (AppPeek) read it this one way.
 */
type PreviewRead = { content: string | ArrayBuffer | null; binary?: boolean; acknowledged?: Promise<void>; videoUrl?: string; expiresAt?: number; renew?: () => Promise<{ videoUrl: string; expiresAt: number }>; release?: () => Promise<void>; error?: string; retryable?: boolean; errorStatus?: 'gone' | 'expired' | 'missing' | 'failed' }
class OfflinePreviewRead extends Error {
  constructor(readonly holder: NonNullable<Awaited<ReturnType<typeof offlineHolder>>>, cause: unknown) { super(holderOfflineText(holder), { cause }) }
}
const previewFailure = (error: unknown, t: TFunction<'messaging'>): PreviewRead => ({ content: null, ...fileReadFailure(error, t) })
async function readPreview(file: PreviewFile | HostedPreviewFile, kind: DocumentPreviewKind, options: NonNullable<Parameters<typeof previewBytes>[1]>): Promise<PreviewRead> {
  // A video read whole from here (a working copy, or a file this device sent this run) plays from its own bytes.
  const whole = documentPreviewNeedsFetch(kind) ? null : file.source.kind === 'hosted' ? await file.source.read() : file.document ? null : sentFileCopy(file.source)
  if (whole) {
    const videoUrl = URL.createObjectURL(whole)
    return { content: null, videoUrl, expiresAt: Infinity, release: async () => URL.revokeObjectURL(videoUrl) }
  }
  if (file.source.kind !== 'hosted' && !documentPreviewNeedsFetch(kind)) {
    const preview = await attachmentPreview(file.source, undefined, options.signal)
    if (preview.status !== 'ready') throw new Error(preview.status)
    let objectUrl: string | undefined
    const renew = async () => {
      const content = await preview.content()
      if (!(content instanceof Blob)) return { videoUrl: content.url, expiresAt: content.expiresAt }
      objectUrl ??= URL.createObjectURL(content)
      return { videoUrl: objectUrl, expiresAt: Infinity }
    }
    const release = async () => { if (objectUrl) URL.revokeObjectURL(objectUrl); await preview.dispose() }
    try { return { content: null, ...await renew(), renew, release } } catch (error) { await release(); throw error }
  }
  const { blob, acknowledged } = await previewBytes(file, options)
  // Heard here too: if turning the bytes into content throws below, nobody else is left to hear a refused acknowledgement.
  acknowledged?.catch(() => undefined)
  if (kind === 'image') {
    const content = URL.createObjectURL(blob)
    return { content, acknowledged, release: async () => URL.revokeObjectURL(content) }
  }
  // A `.ts` / `.mts` is TypeScript or a recording whatever type it was stored with; only its bytes tell. A recording is shown
  // like any video this preview cannot play.
  if (kind === 'text' && await isMpegTsVideo(file.fileName, blob)) return { content: null, binary: true, acknowledged }
  return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer(), acknowledged }
}

/** The host's preview wherever a file opens: messages, the chat's folder and an App's peek. */
export function MessageFilePreview({ file, mobile = false, fill = false, tabbed = false, readOnly = false, message, onForward, onBack, onClose }: { file: PreviewFile | HostedPreviewFile; mobile?: boolean; fill?: boolean; tabbed?: boolean; readOnly?: boolean; message?: MessageItem; onForward?: (message: MessageItem) => void; onBack?: () => void; onClose: () => void }) {
  const reader = useId()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const kind = classifyDocumentPreview(file)
  const key = file.source.kind === 'hosted' ? file.source.key : sourceKeyOf(file.source)
  const activeKey = useRef(key)
  const viewerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (readOnly || !viewerRef.current || (file.source.kind !== 'item' && file.source.kind !== 'hosted' && !message)) return
    return bindFileViewerMenu(viewerRef.current, () => ({
      resource: file.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: file.source.itemId, version: file.source.version } } : undefined,
      quote: async (selection) => {
        if (file.source.kind === 'hosted') return file.source.quote(selection)
        if (file.source.kind === 'item') return quoteChatFile(file.source.itemId, file.source.version, selection)
        const { UI_EVENTS } = await import('@/lib/uiEvents')
        window.dispatchEvent(new CustomEvent(UI_EVENTS.quoteMessage, { detail: { messageId: message!.id, source: message, senderName: file.fileName, content: selection ? selectedTextQuote(selection) : file.fileName } }))
      },
      canSelectAll: !(mobile && kind === 'html') && kind !== 'image' && kind !== 'video' && kind !== 'unsupported',
    }), (error) => toast(error instanceof Error ? error.message : String(error), 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source identity retains the menu snapshot across unrelated renders
  }, [key, file.fileName, message?.id, kind, mobile, toast, readOnly])
  const [read, setRead] = useState<PreviewRead | null>(null)
  const [progress, setProgress] = useState<ReadProgress>()
  const [saving, setSaving] = useState<ReadProgress>()
  const savingRequest = useRef<AbortController | null>(null)
  useEffect(() => {
    setSaving(undefined)
    return () => { savingRequest.current?.abort(); savingRequest.current = null }
  }, [key])
  // A chat folder's HTML document is given its folder: the files its page names beside it are shown (preview-protocol).
  const [besideOffline, setBesideOffline] = useState<{ machine: string; deviceId: string } | null>(null)
  // The machine a failed read waits for: when the device list sees it go from off to on, the file is read again by itself.
  const [waitingFor, setWaitingFor] = useState<{ deviceId: string; itemId?: string; version?: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useHolderBack(waitingFor, () => { setWaitingFor(null); setBesideOffline(null); setAttempt((n) => n + 1) })
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
    }, (holder) => { setBesideOffline(holder); setWaitingFor(holder) })
  }, [hostedHtml, itemId, t])
  useEffect(() => {
    activeKey.current = key
    let live = true, release: PreviewRead['release']
    setRead(null)
    setProgress(undefined)
    const source = file.source
    const queryKey = ['file-preview-read', reader, key, kind, attempt]
    if (kind !== 'unsupported') void queryClient.fetchQuery({
      queryKey, gcTime: 0, retry: (failures, error) => failures < 3 && !(error instanceof OfflinePreviewRead || error instanceof FileReadError) && previewFailure(error, t).retryable === true,
      queryFn: async ({ signal }) => {
        let done: PreviewRead
        try { done = await readPreview(file, kind, { signal, onState: fileReadProgress(t, next => { if (live) setProgress(next) }) }) }
        catch (error) {
          if (signal.aborted) throw signal.reason
          const holder = source.kind === 'item' && (!(error instanceof FileReadError) || error.code === 'holder_offline') ? await offlineHolder(source.itemId, source.version) : null
          if (holder) throw new OfflinePreviewRead(holder, error)
          throw error
        }
        if (signal.aborted) { void done.acknowledged?.catch(() => {}); await done.release?.(); throw signal.reason }
        return done
      },
    }).then(
      (done) => {
        release = done.release
        // Shown before the server acknowledged the read: a refusal takes it down and says why.
        done.acknowledged?.catch((error) => { if (!live) return; void release?.(); release = undefined; setRead(previewFailure(error, t)) })
        if (!live) { void release?.(); return }
        setRead(done)
      },
      (error) => {
        if (!live) return
        // The query already checked the holder afresh. Cancellation must not start another metadata read after sign-out.
        const offline = error instanceof OfflinePreviewRead ? error.holder : null
        setWaitingFor(offline)
        setRead(offline !== null ? { content: null, errorStatus: 'failed', error: holderOfflineText(offline) } : previewFailure(error, t))
      },
    )
    return () => { live = false; void queryClient.cancelQueries({ queryKey, exact: true }); queryClient.removeQueries({ queryKey, exact: true }); void release?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source kind/id/version and the preview kind identify the bytes; attempt reads them again
  }, [key, kind, file.document, message?.id, message?.chat_id, t, attempt, reader])
  const renewVideo = async (video: HTMLVideoElement) => {
    const current = read
    if (video.dataset.renewing) return
    const fail = (error?: unknown) => setRead(row => row === current ? { ...row, ...previewFailure(error, t) } : row)
    if (!current?.renew || Date.now() < (current.expiresAt ?? Infinity)) { fail(); return }
    video.dataset.renewing = 'true'
    const time = video.currentTime, playing = !video.paused
    try {
      const next = await current.renew()
      video.addEventListener('loadedmetadata', () => { video.currentTime = time; if (playing) void video.play().catch(fail) }, { once: true })
      setRead(row => row === current ? { ...row, ...next } : row)
    } catch (error) { fail(error) } finally { delete video.dataset.renewing }
  }
  const missing = read?.errorStatus === 'missing'
  const rememberMissing = (error: unknown) => {
    const failure = previewFailure(error, t)
    if (failure.errorStatus !== 'missing') return false
    if (activeKey.current === key) setRead(failure)
    return true
  }
  const savedName = savedFileName({ name: file.fileName, contentType: file.mimeType })
  const save = (operation: (options: { signal: AbortSignal; onState: (state: FileReadState) => void }) => Promise<unknown>, failureLog: string) => {
    if (savingRequest.current) return
    const controller = new AbortController()
    savingRequest.current = controller
    setSaving({ label: t('chatArea.filePreview.loading') })
    const onState = fileReadProgress(t, next => { if (!controller.signal.aborted) setSaving(next) })
    void operation({ signal: controller.signal, onState }).catch((error: unknown) => {
      if (controller.signal.aborted || rememberMissing(error)) return
      fileOpenLog.error({ error }, failureLog)
      toast(t('chatArea.downloadFailed'), 'error', error instanceof FileReadError || error instanceof FileReadRevokedError ? previewFailure(error, t).error : messageForUser(error))
    }).finally(() => {
      if (savingRequest.current !== controller) return
      savingRequest.current = null
      setSaving(undefined)
    })
  }
  const openExternal = () => {
    if (missing) return
    if (file.source.kind === 'hosted') { file.source.openExternal?.(); return }
    const source = file.source
    save(options => openAttachmentInSystemApp(source, savedName, options), 'system app handoff failed')
  }
  const download = () => {
    if (missing) return
    if (file.source.kind === 'hosted') { file.source.download(); return }
    const source = file.source
    save(async (options) => {
      if (!file.document && attachmentFileRef(source)) return downloadAttachment(source, savedName, options)
      const { blob } = await previewBytes(file)
      options.signal.throwIfAborted()
      await downloadBlob(blob, savedName)
    }, 'preview file download failed')
  }
  const actions = messageActionItems({ isRetracted: !!message?.retracted_at, content: message?.content ?? null, onForward: !readOnly && message && onForward ? () => onForward(message) : undefined, onDownload: missing ? undefined : download }, t)
  const downloadAction = actions.find(item => item.key === 'download')
  if (saving && downloadAction) downloadAction.disabled = true
  if (file.source.kind === 'hosted' && !missing) for (const app of file.source.openIn ?? []) actions.push({ key: `open-in-${app.key}`, icon: SquareArrowRight, label: app.label, onSelect: app.open })
  const connection = besideOffline ? <ConnectionStatus state="device_offline" subject={besideOffline.machine || t('attachmentView.holderMachine')} testId="message-file-preview-connection" /> : undefined
  // `key`: a read again (the machine back) gives the HTML preview a new registration, so its files are asked for again.
  const shown = read?.binary ? 'unsupported' : kind
  const loading = (kind !== 'unsupported' && read === null) || (shown === 'unsupported' && !!saving)
  const status = saving ?? progress
  return <MessageFilePreviewPanel key={attempt} {...(file.source.kind === 'hosted' ? { folders: file.source.folders, onCite: readOnly || !file.source.citesSelection ? undefined : file.source.quote, onSend: readOnly ? undefined : file.source.send, annotation: readOnly ? undefined : file.source.annotation, unreadableAction: file.source.unreadableAction, ...(file.source.edit ? { onEdit: file.source.edit } : {}) } : {})} connection={connection} onReadAgain={read?.retryable && !waitingFor && file.source.kind !== 'hosted' ? () => setAttempt(n => n + 1) : undefined} registerHtml={registerHtml} at={at} viewerRef={viewerRef} fill={fill} tabbed={tabbed} mobile={mobile} file={file} kind={shown} content={read?.content ?? null} videoUrl={read?.videoUrl} onVideoError={renewVideo} loading={loading} showLoadingStatus={!!saving} loadingLabel={status?.label} loadingFraction={status?.fraction} error={read?.error} onBack={onBack} onClose={onClose} actions={actions} onOpenExternal={missing || file.document || (file.source.kind === 'url' && file.source.url.startsWith('blob:')) || (file.source.kind === 'hosted' ? !file.source.openExternal : shown === 'unsupported') ? undefined : openExternal} />
}
