import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { buildRosterNameIndex, resolveOpeningAgentCall } from '@gugu/core/shared/rosterNameMatching.mjs'
import { firstMentionedUserId, resolveMentionUserIds, type MentionCandidate } from '@/lib/mention'
import { rememberGroupMention } from '@/lib/groupMentionRecall'
import { scheduleComposerFocus } from '@/lib/focusComposer'
import { rendererLogger } from '@/lib/log'
import { chatSendFailureNotice } from './chatSendFailureNotice'
import { useToast } from '../toastContext'
import { revokeAttachmentPreviewUrls, withPreviewUrl, type ChatDraft, type MentionTarget } from './useChatDraft'
import { contentWithQuote } from './messageQuoteContent'
import type { ChatMessageComposerProps } from './chatComposerModels'
import { useChatStore } from '../../store/chatContext'
import { messageFailureNotice } from '@/lib/messageFailureNotice'

/** Chat delivery owns recipients and rollback; the shared editor only submits its document. */
export function useChatMessageSend(props: ChatMessageComposerProps, draft: ChatDraft, members: MentionCandidate[], activeMentionTargets: MentionTarget[], inputRef: RefObject<HTMLElement | null>, mobile = false) {
  const { onSend, beforeSend, onSendAttachments, quoteContent, onQuoteConsumed, chatId, currentUserId, isGroupChat, disabled, disabledReason, whisperTarget, onExitWhisper } = props
  const { text, attachments, clear, flush, setMentionTargets, setAttachments, persistTo } = draft
  const { writeDraft } = useChatStore('writeDraft')
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const submissions = useRef(new Map<string, { id: string; revision: object; destination: string; failure: ReturnType<typeof messageFailureNotice> }>())
  const activeChatIdRef = useRef(chatId ?? null)
  activeChatIdRef.current = chatId ?? null
  const rosterNameIndex = useMemo(() => buildRosterNameIndex(props.groupMembers ?? []), [props.groupMembers])
  const handleSend = useCallback(async (value?: string) => {
    // 回车走 handleKeyDown 直达这里、不看按钮的 disabled:在途时再进就会把同一批附件重发一遍。
    if (sendingRef.current) return
    const submittedAt = performance.now()
    const typed = (value ?? text).trim()
    const pendingFiles = attachments.map((a) => a.file)
    const multimodalImage = pendingFiles.some((file) => inferAttachmentKind(file) === 'image')
    if (disabled) {
      toast(disabledReason || t('composer.disabled'), 'info')
      return
    }
    if (!typed && pendingFiles.length === 0) return
    const content = contentWithQuote(typed, quoteContent)
    // @@@whisper (#820) — 悄悄话模式下覆盖 toUserIds + 附加 isWhisper flag；禁用 @提及。
    const replyToMessageId = quoteContent?.messageId ?? null
    const explicitRecipientIds = resolveMentionUserIds(
      typed,
      activeMentionTargets.map((target) => target.userId),
      members,
      !!isGroupChat,
    )
    const rosterRecipientIds = !whisperTarget && isGroupChat && explicitRecipientIds.length === 0 && !replyToMessageId
      ? resolveOpeningAgentCall(rosterNameIndex, typed)
      : []
    const sendOptions = whisperTarget
      ? {
          toUserIds: [whisperTarget.userId],
          replyToMessageId,
          isWhisper: true,
        }
      : {
          // @@@1703 — union picker selections with @tokens typed inline. Typing "@Name " without selecting the
          // picker left mentionTargets empty → to_user_ids=null → the DB non-@ branch drops passive members
          // (listen_mode = active) → silence. Parse the typed text for member @tokens too so a typed
          // @mention hard-triggers identically to a picked one.
          // #1641 human-only send adapter: an opening call resolved against the already-subscribed group
          // roster becomes the same structural recipient as @. The DB trigger still reads no message text.
          toUserIds: [...new Set(explicitRecipientIds.length ? explicitRecipientIds : rosterRecipientIds)],
          replyToMessageId,
        }

    const scope = JSON.stringify([currentUserId, chatId])
    const revision = draft.revisionOf(chatId ?? null)
    const destination = JSON.stringify([!!sendOptions.isWhisper, sendOptions.replyToMessageId, [...sendOptions.toUserIds].sort()])
    let submission = submissions.current.get(scope)
    if (!submission || submission.revision !== revision || submission.destination !== destination) {
      const id = crypto.randomUUID()
      submission = { id, revision, destination, failure: messageFailureNotice(['im', currentUserId ?? 'signed-out', chatId ?? 'composer', id]) }
      submissions.current.set(scope, submission)
    }
    const attempt = submission.failure.begin()
    let clearedRevision = revision

    // Snapshot current attachments so we can roll back on failure
    const snapshotAttachments = attachments
    // Once the files are rows in the conversation they belong to those rows (uploading, failing, resending there):
    // a later failure in this send never puts them back in the composer.
    let filesOwned = false
    // 带引用回复时文字单独走 onSend(它带 replyToMessageId),不挂成图片说明——否则引用关系丢失。
    const captionOnImage = multimodalImage && !replyToMessageId
    sendingRef.current = true
    setSending(true)
    try {
      // C1:先清空输入框、先上屏乐观气泡。会话就绪不再挡在前面(它可能要重开会话,气泡迟迟不出):
      // 文字消息把它交给 outbox 在投递前 await,失败时气泡变「未送达」可重试,❌ 退回输入框。
      clear()
      flush()
      clearedRevision = draft.revisionOf(chatId ?? null)
      onQuoteConsumed?.()
      scheduleComposerFocus('message-sent', { target: () => inputRef.current, mobileShell: mobile })
      if (pendingFiles.length > 0 && onSendAttachments) await beforeSend?.()

      // Resolves once the files are on screen; their bytes upload after the composer is free again.
      let lastFile: string | undefined
      if (pendingFiles.length > 0 && onSendAttachments) {
        lastFile = (await onSendAttachments(pendingFiles, { toUserIds: sendOptions.toUserIds, replyToMessageId: !typed && replyToMessageId ? replyToMessageId : undefined, isWhisper: !!whisperTarget, caption: captionOnImage ? content || undefined : undefined })) || undefined
        filesOwned = true
      }
      if (typed && (!captionOnImage || !onSendAttachments)) {
        // Text sent with files reaches the conversation after them, as it was written.
        await onSend(content, { ...sendOptions, clientMessageId: submission.id, beforeDeliver: beforeSend, submittedAt, ...(lastFile ? { dependsOn: lastFile } : {}) })
      }
      if (attempt.succeeded() && submissions.current.get(scope) === submission) submissions.current.delete(scope)
      // Successful send → object URLs are no longer needed
      revokeAttachmentPreviewUrls(snapshotAttachments)
      if (!mobile && isGroupChat && currentUserId && chatId && !whisperTarget) {
        const first = firstMentionedUserId(typed, explicitRecipientIds, members)
        if (first !== undefined) rememberGroupMention(currentUserId, chatId, first)
      }
      // @@@whisper (#820) — clear whisper mode after a successful send.
      if (whisperTarget) onExitWhisper?.()
    } catch (err) {
      const unchanged = draft.revisionOf(chatId ?? null) === clearedRevision
      const reason = String((err as Error)?.message ?? err)
      rendererLogger('chat/send').error({ chatId, error: reason }, 'message send failed')
      // Rollback restores only UNSENT intent. @@@2188 - units already in the conversation must NOT return to the
      // draft, or a retry re-sends them (duplicate attachment). Files become rows all together or not at all.
      const unsentAttachments = filesOwned ? [] : snapshotAttachments
      // @@@draft-attachment (#1872) - restore WITHOUT contaminating the wrong chat: send is async, so the
      // user may have switched away mid-flight (composer stays mounted, chatId differs). Restore into the
      // LIVE composer only when still on the sending chat; otherwise re-persist into the ORIGINAL chat's
      // store (its restore path picks it up on return) — never leaking a private file into another chat.
      const restoredMentions = sendOptions.toUserIds.length > 0 ? activeMentionTargets : []
      // `?? null` so a composer with no chat context (chatId undefined) still matches the null-initialized
      // ref and restores locally — the "switched away" branch only applies to a real chatId change.
      if (activeChatIdRef.current === (chatId ?? null)) {
        // Reuse the same File objects but mint fresh preview URLs (the old ones may already be revoked).
        // 合并而非覆盖:多件逐一上传的空档里用户可能又加了附件、又打了字,整体替换会把它们吞掉。
        writeDraft(chatId, { at: 'start', text: typed })
        setMentionTargets((current) => [...restoredMentions, ...current.filter((m) => !restoredMentions.some((r) => r.userId === m.userId))])
        setAttachments((current) => [...unsentAttachments.map(withPreviewUrl), ...current])
      } else if (chatId) {
        persistTo(chatId, { text: typed, mentions: restoredMentions, attachments: unsentAttachments })
      }
      // Drop the now-stale snapshot URLs (replaced by fresh ones above, or unused when persisting to store).
      revokeAttachmentPreviewUrls(snapshotAttachments)
      if (unchanged) submission.revision = draft.revisionOf(chatId ?? null)
      attempt.failed(chatSendFailureNotice(unsentAttachments.map((attachment) => attachment.file), err, t))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [draft, beforeSend, chatId, currentUserId, text, attachments, activeMentionTargets, members, rosterNameIndex, isGroupChat, onSend, onSendAttachments, quoteContent, onQuoteConsumed, t, toast, disabled, disabledReason, whisperTarget, onExitWhisper, writeDraft, setMentionTargets, setAttachments, clear, persistTo, flush, inputRef, mobile])

  return { sending, handleSend }
}
