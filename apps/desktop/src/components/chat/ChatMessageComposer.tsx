import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations'
import { AnnotationTray } from '@renderer/features/sessions/annotations/annotation-tray'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { resolveReplyDelivery } from '@gugu/core/shared/replyDelivery'
import { ChatComposer, MessageProvider, type ComposerAttachment, type MentionItem, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { useLocale } from '@/i18n'
import { focusComposer, registerComposerFocusTarget, scheduleComposerFocus } from '@/lib/focusComposer'
import { useComposerEntryFocus } from '@/lib/composerEntryFocus'
import { activeMentionPicks } from '@/lib/mention'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { UI_EVENTS } from '@/lib/uiEvents'
import { useChatStore } from '../../store/chatContext'
import { useTheme } from '../../store/theme'
import { useMobileShell } from '../../hooks/useMobileShell'
import { useInChatSlot, useChatSlotProjectName } from '../../lib/shellSlots'
import { sessionComposerDockedWidthClassName } from '../../session/renderer/features/sessions/session-composer-styles'
import { useChatTaskDrop } from './useChatTaskDrop'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { useDraftAttachmentPreview } from './useDraftAttachmentPreview'
import { useChatDraft, makePendingAttachment, revokeAttachmentPreviewUrls } from './useChatDraft'
import { useChatMessageSend } from './useChatMessageSend'
import { ComposerAttachButton } from './ComposerAttachButton'
import { PhoneAttachPanel } from './PhoneAttachPanel'
import { compressPhoto } from './compressPhoto'
import { IconButton } from '../ui/IconButton'
import { Camera, Image, Paperclip } from '@/lib/icons'
import { useComposerVerbTakeover } from './useComposerVerbTakeover'
import { ChatComposerContextBands } from './ChatComposerContextBands'
import { useGroupMentionProvider } from './useGroupMentionProvider'
import type { ChatMessageComposerProps } from './chatComposerModels'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { useAttachmentFileSelection } from '@/hooks/useAttachmentFileSelection'
import { useGroupMentionHint } from './useGroupMentionHint'
import { usePromptLibrary } from '@renderer/features/library/prompts/use-prompt-library'
import { promptSlashItems } from '@renderer/features/library/prompts/prompt-slash-items'
import './group-mention-hint.css'
export type { ComposerAttachAction } from './ComposerAttachButton'
export type { ChatMessageComposerProps } from './chatComposerModels'

const EMPTY_MEMBERS: NonNullable<ChatMessageComposerProps['groupMembers']> = []
const EMPTY_STATUSES: NonNullable<ChatMessageComposerProps['agentStatuses']> = {}
const EMPTY_MESSAGES: NonNullable<ChatMessageComposerProps['messages']> = []

/** Chat-specific delivery and context around the same editor used by ACP tasks. */
export const ChatMessageComposer = observer(function ChatMessageComposer(props: ChatMessageComposerProps) {
  const { chatId, isGroupChat, groupMembers = EMPTY_MEMBERS, currentUserId, agentStatuses = EMPTY_STATUSES,
    placeholder, attachGlyph, attachMenu, mentionToInsert, onMentionInserted, quoteContent, onExitWhisper: exitWhisper,
    messages = EMPTY_MESSAGES, hidden = false } = props
  const [publicQuote, setPublicQuote] = useState<typeof quoteContent>(null)
  const replySource = quoteContent?.source
  const { draftWhispers, setDraftWhisper } = useChatStore('draftWhispers', 'setDraftWhisper')
  const whisperTo = props.whisperTarget?.userId ?? (chatId ? draftWhispers[chatId] : undefined)
  const delivery = resolveReplyDelivery({ senderUserId: currentUserId, source: replySource,
    toUserIds: whisperTo ? [whisperTo] : [],
    whisper: whisperTo ? true : quoteContent && publicQuote === quoteContent ? false : undefined })
  const privatePeer = delivery?.isWhisper ? delivery.toUserIds[0] : undefined
  const whisperTarget = useMemo(() => privatePeer ? { userId: privatePeer, displayName: groupMembers.find((member) => member.id === privatePeer)?.name
    ?? (props.whisperTarget?.userId === privatePeer ? props.whisperTarget.displayName : quoteContent?.senderName ?? privatePeer) } : null,
  [privatePeer, groupMembers, props.whisperTarget, quoteContent?.senderName])
  const onExitWhisper = useCallback(() => { setPublicQuote(quoteContent); if (chatId) setDraftWhisper(chatId, null); exitWhisper?.() }, [quoteContent, chatId, setDraftWhisper, exitWhisper])
  const deliveryProps = { ...props, whisperTarget, onExitWhisper }
  const { t } = useTranslation('messaging')
  const replyUnavailable = !delivery || (!!quoteContent?.messageId && !replySource)
  const disabled = props.disabled || replyUnavailable
  const disabledReason = replyUnavailable ? t('composer.replyUnavailable') : props.disabledReason
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const mobile = useMobileShell()
  const draft = useChatDraft(chatId)
  const annotationConversation = useMemo(() => chatId ? { kind: 'chat' as const, chatId } : undefined, [chatId])
  const annotationDraft = annotationConversation ? sessionAnnotations.forConversation(annotationConversation) : undefined
  const { text, setText, mentionTargets, setMentionTargets, attachments, setAttachments } = draft
  const fileSelection = useAttachmentFileSelection(attachments, chatId)
  const draftPreview = useDraftAttachmentPreview(chatId, mobile && !hidden, id => attachments.find(item => item.id === id)?.file, (id, file, caption) => replaceAttachment(id, file, caption))
  const editorApiRef = useRef<PromptEditorRef | null>(null)
  const inputRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  // 手机附件面板。
  const [attachOpen, setAttachOpen] = useState(false)
  const inChatSlot = useInChatSlot()
  const projectName = useChatSlotProjectName()
  const takenOver = useComposerVerbTakeover(chatId)
  const { identitiesById, registerDraftEditor } = useChatStore('identitiesById', 'registerDraftEditor')
  const { members, mentionProvider, renderMentionIcon, pickOf } = useGroupMentionProvider({ chatId, isGroupChat: !!isGroupChat, groupMembers, currentUserId: currentUserId ?? null,
    agentStatuses, messages, replyToMessageId: quoteContent?.messageId, enabled: !whisperTarget })
  const activeTargets = activeMentionPicks(text, mentionTargets, members)
  const { sending, handleSend } = useChatMessageSend({ ...deliveryProps, disabled, disabledReason }, draft, members, activeTargets, inputRef, mobile)
  const receiveInput = useCallback((element: HTMLElement | null) => { inputRef.current = element }, [])
  const enqueueFiles = useCallback((files: File[]) => {
    const picked = fileSelection.choose(files)
    if (picked.length) setAttachments((pending) => [...pending, ...picked.map(({ file, id }) => makePendingAttachment(file, id))])
    return picked
  }, [fileSelection, setAttachments])
  const { dataDropTypes, onDataDropped, onDirectoriesDropped, invitation } = useChatTaskDrop({ chatId, isGroupChat: isGroupChat && !mobile, groupMembers, provider: mentionProvider, editorApiRef, enabled: !hidden && !disabled, attachFiles: enqueueFiles })
  // 照片 / 拍摄先原样进附件区,压完按 id 换成压缩件:这期间发送、删除、切会话都找不到这个 id,换不到别处去。
  const enqueuePhotos = useCallback((files: File[]) => {
    for (const { file, id } of enqueueFiles(files)) {
      void compressPhoto(file).then((compressed) => {
        if (compressed !== file) setAttachments((pending) => pending.map((item) => item.id === id ? { ...item, file: compressed, photo: { original: file, compressed } } : item))
      })
    }
  }, [enqueueFiles, setAttachments])
  // 编辑过的图换掉原来那一枚:同一个 id、同一个位置,原图不留。原来是照片(带压缩件)的,编辑后照样压一次。
  // 查看器开在更早的一次渲染里,所以按 id 取此刻的那一枚(照片可能已经压完换了文件)。
  const currentAttachments = useRef(attachments)
  currentAttachments.current = attachments
  const replaceAttachment = (id: string, file: File, caption: string) => {
    const previous = currentAttachments.current.find((item) => item.id === id)
    if (!previous) return
    revokeAttachmentPreviewUrls([previous])
    setAttachments((pending) => pending.map((item) => item.id === id ? makePendingAttachment(file, id) : item))
    if (caption) editorApiRef.current?.insertText(caption, 'end')
    if (previous.photo) void compressPhoto(file).then((compressed) => { if (compressed !== file) setAttachments((pending) => pending.map((item) => item.id === id && item.file === file ? { ...item, file: compressed, photo: { original: file, compressed } } : item)) })
  }

  useEffect(() => registerComposerFocusTarget(() => inputRef.current), [])
  useComposerEntryFocus(chatId ? 'chat:' + chatId : null, !hidden && props.entryActive === true, () => {
    if (!disabled) focusComposer('chat-entry', { mobileShell: mobile, target: () => inputRef.current })
  })
  // 面板占的是键盘的位置:一点输入框(键盘要起来)就收起。
  useEffect(() => {
    const input = inputRef.current
    if (!attachOpen || !input) return
    const close = () => setAttachOpen(false)
    input.addEventListener('focus', close)
    return () => input.removeEventListener('focus', close)
  }, [attachOpen])
  useLayoutEffect(() => registerDraftEditor(chatId ?? null, () => editorApiRef.current), [chatId, registerDraftEditor])
  useEffect(() => {
    if (!mentionToInsert) return
    editorApiRef.current?.insertMention({ id: mentionToInsert.id, label: mentionToInsert.name, name: mentionToInsert.name, kind: 'custom' })
    onMentionInserted?.()
  }, [mentionToInsert, onMentionInserted])
  useEffect(() => {
    if (quoteContent) scheduleComposerFocus('quote-attached', { target: () => inputRef.current })
  }, [quoteContent])
  useEffect(() => {
    const attach = (event: Event) => {
      const files = (event as CustomEvent<{ files?: unknown }>).detail?.files
      if (Array.isArray(files)) enqueueFiles(files.filter((file): file is File => file instanceof File))
    }
    window.addEventListener(UI_EVENTS.composerAttachFiles, attach)
    return () => window.removeEventListener(UI_EVENTS.composerAttachFiles, attach)
  }, [enqueueFiles])

  const composerAttachments: ComposerAttachment[] = attachments.map((attachment) => ({
    id: attachment.id, name: attachment.file.name, kind: attachment.kind === 'image' ? 'image' : 'file',
    previewUrl: attachment.previewUrl ?? undefined, mimeType: attachment.file.type, meta: formatAttachmentSize(attachment.file.size),
    hasLocalPreview: mobile,
    imageQuality: attachment.photo && (attachment.file === attachment.photo.compressed ? 'compressed' : 'original'),
  }))
  const onMentionInsert = (item: MentionItem) => {
    const pick = pickOf(item)
    if (pick) setMentionTargets((picks) => picks.some((existing) => existing.userId === pick.userId) ? picks : [...picks, pick])
  }
  const recallMembers = members.filter((member) => !identitiesById[member.id]?.removed_at)
  const { hint, ...hintEvents } = useGroupMentionHint({ accountId: currentUserId, chatId, members: recallMembers, text,
    enabled: !mobile && !!isGroupChat && !props.conversation && !disabled && !sending && !hidden && !takenOver && !whisperTarget,
    editor: editorApiRef, input: inputRef })
  const editorOptions = { inputTestId: AUTOMATION_TEST_IDS.chatComposer,
    inputRef: receiveInput, clearOnSubmit: false, enterBehavior: mobile ? 'newline' as const : 'submit' as const, emptyHint: hint }
  // `/`: the person's prompts and their Apps' (prompt-slash-items.ts, the session composer's same list) — the chat's `/` had nothing.
  const { value: prompts, overrides } = usePromptLibrary()
  const queryPrompts = useCallback(async (query: string) => promptSlashItems(prompts, overrides, translateSessionMessage('chat.prompts'), query.trim().toLowerCase()), [prompts, overrides])
  const Composer = props.conversation ? AgentConversationComposer : ChatComposer
  return <SessionUiTheme theme={theme}>
    <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
      <div {...hintEvents} title={disabledReason} data-chat-composer-host="" data-mobile-group={mobile && isGroupChat || undefined} data-sending={sending} hidden={hidden || takenOver}>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { enqueueFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        {mobile && <>
          {/* 照片 = 系统相册(只写 image/*:写多个类型时 Android 壳退回成文件选择器);拍摄 = 直接开相机。 */}
          <input ref={photoInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { enqueuePhotos(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { enqueuePhotos(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </>}
        <ChatComposerContextBands {...deliveryProps} />
        {invitation}
        <Composer {...props.conversation} key={chatId} editorApiRef={editorApiRef} editorOptions={editorOptions} mobile={mobile}
          disabled={disabled} disabledPlaceholder={placeholder ?? disabledReason} canSubmit={!sending && (!!text.trim() || attachments.length > 0 || !!annotationDraft?.items.length)}
          placeholder={props.conversation ? undefined : (whisperTarget ? t('composer.whisperPlaceholder', { name: whisperTarget.displayName }) : placeholder ?? (mobile && isGroupChat ? t('composer.mobilePlaceholder') : projectName && !mobile ? t('composer.projectGroupPlaceholder', { name: projectName }) : t('composer.placeholder')))}
          onInputChange={setText} onSubmitWhileWorking={props.conversation ? handleSend : undefined} onSubmit={handleSend} onMentionInsert={onMentionInsert}
          mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} queryCommands={queryPrompts} dataDropTypes={dataDropTypes} onDataDropped={onDataDropped}
          onFilesDropped={enqueueFiles} onImageFilesDropped={enqueueFiles} onDirectoriesDropped={onDirectoriesDropped}
          attachments={composerAttachments} onViewAttachment={draftPreview.open} onAttachmentsChange={(next) => { const kept = attachments.filter((file) => next.some((item) => item.id === file.id)); revokeAttachmentPreviewUrls(attachments.filter((file) => !kept.includes(file))); setAttachments(kept) }}
          attachmentExtra={annotationConversation && annotationDraft?.items.length ? <AnnotationTray conversation={annotationConversation} onSend={() => { void handleSend() }} enabled={!disabled && !sending && !hidden && !takenOver} /> : null}
          onAttachmentQualityChange={(id) => setAttachments((pending) => pending.map((item) => item.id === id && item.photo ? { ...item, file: item.file === item.photo.compressed ? item.photo.original : item.photo.compressed } : item))}
          toolbarExtra={mobile
            ? <IconButton shape="pill" size="md" title={t('composer.attach')} aria-label={t('composer.attach')} aria-expanded={attachOpen} disabled={disabled} data-testid="chat-composer-attach-menu"
          data-phone-attachment=""
                onClick={() => { inputRef.current?.blur(); setAttachOpen((open) => !open) }}><Paperclip /></IconButton>
            : <ComposerAttachButton glyph={attachGlyph} actions={attachMenu} disabled={disabled} mobile={mobile} onPickFile={() => fileInputRef.current?.click()} />}
          className={inChatSlot ? sessionComposerDockedWidthClassName : undefined} />
        {draftPreview.panel}
        {mobile && attachOpen && <PhoneAttachPanel onClose={() => setAttachOpen(false)} entries={[
          { id: 'photos', label: t('composer.photos'), icon: <Image />, onSelect: () => photoInputRef.current?.click() },
          { id: 'camera', label: t('composer.camera'), icon: <Camera />, onSelect: () => cameraInputRef.current?.click() },
          { id: 'file', label: t('composer.file'), icon: <Paperclip />, onSelect: () => fileInputRef.current?.click() },
        ]} />}
      </div>
    </MessageProvider>
  </SessionUiTheme>
})
